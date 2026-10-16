package service

import (
	"context"
	"sync"
	"time"

	"github.com/emersion/go-imap"
	imapclient "github.com/emersion/go-imap/client"
)

// Reusing an authenticated IMAP connection removes a full TCP + TLS + LOGIN
// round trip from every page view, which is the bulk of the latency on the mail
// page. Connections are kept per mailbox account and verified with a cheap NOOP
// before being handed out again, because providers drop idle sessions on their
// own schedule.
const (
	imapPoolIdleTTL       = 90 * time.Second
	imapPoolMaxAge        = 10 * time.Minute
	imapPoolMaxPerAcct    = 3
	imapPoolVerifyTTL     = 3 * time.Second
	imapPoolSweepInterval = 30 * time.Second
)

type pooledIMAPConn struct {
	client     *imapclient.Client
	accountID  int64
	createdAt  time.Time
	lastUsedAt time.Time
	mu         sync.Mutex
	broken     bool
}

// imapLease pins one pooled connection for the duration of a request. IMAP
// multiplexes commands on a single socket, so a lease is never shared; the
// embedded mutex keeps a connection from being handed out twice.
type imapLease struct {
	conn *pooledIMAPConn
	svc  *MailService
}

func (lease *imapLease) Client() *imapclient.Client { return lease.conn.client }

// Release returns the connection to the pool. Pass the error the caller saw (or
// nil on success) so a dead socket is closed instead of being reused.
func (lease *imapLease) Release(err error) { lease.svc.releaseIMAP(lease.conn, err != nil) }

// acquireIMAP hands out a live connection for one mailbox and a release
// function that must be called exactly once, with the operation's error.
func (s *MailService) acquireIMAP(session *mailSession) (*imapclient.Client, func(err error), error) {
	lease, err := s.leaseIMAP(session)
	if err != nil {
		return nil, nil, err
	}
	return lease.Client(), lease.Release, nil
}

// imapPoolReusable reports whether a pooled connection is still worth handing
// out. Idle and total age are bounded because providers silently drop sessions.
func imapPoolReusable(conn *pooledIMAPConn, now time.Time) bool {
	if conn == nil || conn.broken {
		return false
	}
	return now.Sub(conn.lastUsedAt) <= imapPoolIdleTTL && now.Sub(conn.createdAt) <= imapPoolMaxAge
}

func (s *MailService) leaseIMAP(session *mailSession) (*imapLease, error) {
	accountID := session.account.ID
	for {
		s.imapPoolMu.Lock()
		conns := s.imapPool[accountID]
		now := time.Now()
		var reusable *pooledIMAPConn
		kept := make([]*pooledIMAPConn, 0, len(conns))
		for _, conn := range conns {
			if !imapPoolReusable(conn, now) {
				continue
			}
			if reusable == nil {
				reusable = conn
			}
			kept = append(kept, conn)
		}
		s.imapPool[accountID] = kept
		s.imapPoolMu.Unlock()

		// Anything dropped from `kept` is closed outside the lock.
		for _, conn := range conns {
			if conn.broken || containsPooledIMAP(kept, conn) {
				continue
			}
			go closePooledIMAP(conn)
		}

		if reusable == nil {
			break
		}
		reusable.mu.Lock()
		if s.imapConnAlive(reusable.client) {
			reusable.lastUsedAt = now
			return &imapLease{conn: reusable, svc: s}, nil
		}
		reusable.broken = true
		reusable.mu.Unlock()
		_ = reusable.client.Terminate()
	}

	conn, err := s.dialIMAP(session)
	if err != nil {
		return nil, err
	}
	pooled := &pooledIMAPConn{client: conn, accountID: accountID, createdAt: time.Now(), lastUsedAt: time.Now()}
	pooled.mu.Lock()
	return &imapLease{conn: pooled, svc: s}, nil
}

func containsPooledIMAP(conns []*pooledIMAPConn, target *pooledIMAPConn) bool {
	for _, conn := range conns {
		if conn == target {
			return true
		}
	}
	return false
}

var imapPoolJanitorOnce sync.Once

// StartIMAPPoolJanitor closes pooled connections that went idle. Pooled sockets
// are otherwise only reaped when the same mailbox is used again, so an idle
// deployment would keep provider sessions open indefinitely.
func (s *MailService) StartIMAPPoolJanitor(ctx context.Context) {
	imapPoolJanitorOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(imapPoolSweepInterval)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					s.sweepIMAPPool()
				}
			}
		}()
	})
}

func (s *MailService) sweepIMAPPool() {
	now := time.Now()
	s.imapPoolMu.Lock()
	stale := make([]*pooledIMAPConn, 0)
	for accountID, conns := range s.imapPool {
		kept := make([]*pooledIMAPConn, 0, len(conns))
		for _, conn := range conns {
			if imapPoolReusable(conn, now) {
				kept = append(kept, conn)
				continue
			}
			if !conn.broken {
				stale = append(stale, conn)
			}
		}
		if len(kept) == 0 {
			delete(s.imapPool, accountID)
			continue
		}
		s.imapPool[accountID] = kept
	}
	s.imapPoolMu.Unlock()
	for _, conn := range stale {
		go closePooledIMAP(conn)
	}
}

func (s *MailService) releaseIMAP(conn *pooledIMAPConn, failed bool) {
	if conn == nil {
		return
	}
	if failed {
		conn.broken = true
		conn.mu.Unlock()
		s.forgetIMAPConn(conn)
		if conn.client != nil {
			_ = conn.client.Terminate()
		}
		return
	}
	conn.lastUsedAt = time.Now()
	conn.mu.Unlock()

	s.imapPoolMu.Lock()
	defer s.imapPoolMu.Unlock()
	if s.imapPool == nil {
		s.imapPool = make(map[int64][]*pooledIMAPConn)
	}
	if len(s.imapPool[conn.accountID]) >= imapPoolMaxPerAcct {
		go closePooledIMAP(conn)
		return
	}
	s.imapPool[conn.accountID] = append(s.imapPool[conn.accountID], conn)
}

func (s *MailService) forgetIMAPConn(conn *pooledIMAPConn) {
	s.imapPoolMu.Lock()
	defer s.imapPoolMu.Unlock()
	conns := s.imapPool[conn.accountID]
	kept := make([]*pooledIMAPConn, 0, len(conns))
	for _, candidate := range conns {
		if candidate != conn {
			kept = append(kept, candidate)
		}
	}
	s.imapPool[conn.accountID] = kept
}

func closePooledIMAP(conn *pooledIMAPConn) {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	conn.broken = true
	if conn.client != nil {
		_ = conn.client.Logout()
	}
}

// imapConnAlive probes a pooled connection before reuse. NOOP is the cheapest
// command that proves the session still works, so a provider that silently
// dropped the socket is detected here instead of failing the caller's command.
func (s *MailService) imapConnAlive(conn *imapclient.Client) bool {
	if conn == nil || conn.State() != imap.AuthenticatedState {
		return false
	}
	conn.Timeout = imapPoolVerifyTTL
	err := conn.Noop()
	conn.Timeout = mailConnectionTimeout
	return err == nil
}

// invalidateIMAPPool drops every pooled connection for a mailbox. Credentials,
// server settings or the account itself changed, so nothing pooled is trusted.
func (s *MailService) invalidateIMAPPool(accountID int64) {
	s.imapPoolMu.Lock()
	conns := s.imapPool[accountID]
	delete(s.imapPool, accountID)
	s.imapPoolMu.Unlock()
	for _, conn := range conns {
		go closePooledIMAP(conn)
	}
}

func (s *MailService) dialIMAP(session *mailSession) (*imapclient.Client, error) {
	account := session.account
	username := firstNonEmptyMail(account.LoginUsername, account.EmailAddress)
	return s.connectIMAP(session.settings, account, username, session.password)
}
