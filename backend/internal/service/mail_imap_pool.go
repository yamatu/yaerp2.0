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
// page. Idle connections are kept per mailbox account; a leased connection is
// taken out of the pool so concurrent requests never share one socket.
const (
	imapPoolIdleTTL       = 90 * time.Second
	imapPoolMaxAge        = 10 * time.Minute
	imapPoolMaxPerAcct    = 3
	imapPoolVerifyTTL     = 3 * time.Second
	imapPoolTrustRecent   = 10 * time.Second
	imapPoolSweepInterval = 30 * time.Second
)

type pooledIMAPConn struct {
	client    *imapclient.Client
	accountID int64
	// routeKey records the network path (direct or a specific proxy) the
	// connection was dialled over; a changed proxy switch must not reuse it.
	routeKey string
	// generation is the account's pool generation at dial time; invalidating
	// the account bumps it so leased connections are not returned.
	generation uint64
	createdAt  time.Time
	lastUsedAt time.Time
}

// acquireIMAP hands out a live connection for one mailbox and a release
// function that must be called exactly once, with the operation's error.
func (s *MailService) acquireIMAP(session *mailSession) (*imapclient.Client, func(err error), error) {
	route, err := s.resolveMailRoute(session.settings, session.account)
	if err != nil {
		return nil, nil, err
	}
	routeKey := route.key()
	accountID := session.account.ID
	for {
		conn := s.takePooledIMAP(accountID, routeKey)
		if conn == nil {
			break
		}
		if s.imapConnUsable(conn) {
			conn.lastUsedAt = time.Now()
			return conn.client, func(opErr error) { s.releaseIMAP(conn, opErr != nil) }, nil
		}
		go closePooledIMAP(conn)
	}

	s.imapPoolMu.Lock()
	generation := s.imapPoolGen[accountID]
	s.imapPoolMu.Unlock()
	client, err := s.dialIMAP(session)
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	conn := &pooledIMAPConn{
		client: client, accountID: accountID, routeKey: routeKey,
		generation: generation, createdAt: now, lastUsedAt: now,
	}
	return client, func(opErr error) { s.releaseIMAP(conn, opErr != nil) }, nil
}

// takePooledIMAP removes and returns one reusable idle connection, closing
// any that expired or were dialled over a different route.
func (s *MailService) takePooledIMAP(accountID int64, routeKey string) *pooledIMAPConn {
	now := time.Now()
	var taken *pooledIMAPConn
	stale := make([]*pooledIMAPConn, 0)
	s.imapPoolMu.Lock()
	kept := make([]*pooledIMAPConn, 0, len(s.imapPool[accountID]))
	for _, conn := range s.imapPool[accountID] {
		switch {
		case !imapPoolReusable(conn, now) || conn.routeKey != routeKey:
			stale = append(stale, conn)
		case taken == nil:
			taken = conn
		default:
			kept = append(kept, conn)
		}
	}
	if s.imapPool != nil {
		s.imapPool[accountID] = kept
	}
	s.imapPoolMu.Unlock()
	for _, conn := range stale {
		go closePooledIMAP(conn)
	}
	return taken
}

// imapPoolReusable reports whether an idle connection is still worth handing
// out. Idle and total age are bounded because providers silently drop sessions.
func imapPoolReusable(conn *pooledIMAPConn, now time.Time) bool {
	if conn == nil {
		return false
	}
	return now.Sub(conn.lastUsedAt) <= imapPoolIdleTTL && now.Sub(conn.createdAt) <= imapPoolMaxAge
}

// releaseIMAP returns a connection to the pool, or closes it when the caller's
// operation failed, the account was invalidated meanwhile or the pool is full.
func (s *MailService) releaseIMAP(conn *pooledIMAPConn, failed bool) {
	if conn == nil {
		return
	}
	if failed {
		go terminatePooledIMAP(conn)
		return
	}
	conn.lastUsedAt = time.Now()
	s.imapPoolMu.Lock()
	if s.imapPool == nil {
		s.imapPool = make(map[int64][]*pooledIMAPConn)
	}
	if conn.generation != s.imapPoolGen[conn.accountID] || len(s.imapPool[conn.accountID]) >= imapPoolMaxPerAcct {
		s.imapPoolMu.Unlock()
		go closePooledIMAP(conn)
		return
	}
	s.imapPool[conn.accountID] = append(s.imapPool[conn.accountID], conn)
	s.imapPoolMu.Unlock()
}

func closePooledIMAP(conn *pooledIMAPConn) {
	if conn != nil && conn.client != nil {
		_ = conn.client.Logout()
	}
}

func terminatePooledIMAP(conn *pooledIMAPConn) {
	if conn != nil && conn.client != nil {
		_ = conn.client.Terminate()
	}
}

// imapConnUsable does not probe a connection that completed a command moments
// ago; the NOOP would add a full round trip to every click.
func (s *MailService) imapConnUsable(conn *pooledIMAPConn) bool {
	if time.Since(conn.lastUsedAt) <= imapPoolTrustRecent && conn.client != nil && conn.client.State()&imap.AuthenticatedState != 0 {
		return true
	}
	return s.imapConnAlive(conn.client)
}

// imapConnAlive probes an idle connection before reuse. NOOP is the cheapest
// command that proves the session still works, so a provider that silently
// dropped the socket is detected here instead of failing the caller's command.
// A connection that selected a mailbox is in SelectedState, which includes the
// authenticated bit.
func (s *MailService) imapConnAlive(conn *imapclient.Client) bool {
	if conn == nil || conn.State()&imap.AuthenticatedState == 0 {
		return false
	}
	conn.Timeout = imapPoolVerifyTTL
	err := conn.Noop()
	conn.Timeout = mailConnectionTimeout
	return err == nil
}

// invalidateIMAPPool drops every idle connection for a mailbox and makes sure
// connections currently leased are closed instead of returned. Credentials,
// server settings or the proxy choice changed, so nothing pooled is trusted.
func (s *MailService) invalidateIMAPPool(accountID int64) {
	s.imapPoolMu.Lock()
	if s.imapPoolGen == nil {
		s.imapPoolGen = make(map[int64]uint64)
	}
	s.imapPoolGen[accountID]++
	conns := s.imapPool[accountID]
	delete(s.imapPool, accountID)
	s.imapPoolMu.Unlock()
	for _, conn := range conns {
		go closePooledIMAP(conn)
	}
}

var imapPoolJanitorOnce sync.Once

// StartIMAPPoolJanitor closes idle connections. They are otherwise only reaped
// when the same mailbox is used again, so an idle deployment would keep
// provider sessions open indefinitely.
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
	stale := make([]*pooledIMAPConn, 0)
	s.imapPoolMu.Lock()
	for accountID, conns := range s.imapPool {
		kept := make([]*pooledIMAPConn, 0, len(conns))
		for _, conn := range conns {
			if imapPoolReusable(conn, now) {
				kept = append(kept, conn)
			} else {
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

func (s *MailService) dialIMAP(session *mailSession) (*imapclient.Client, error) {
	account := session.account
	username := firstNonEmptyMail(account.LoginUsername, account.EmailAddress)
	return s.connectIMAP(session.settings, account, username, session.password)
}
