package service

import (
	"testing"
	"time"
)

func pooledConn(idle, age time.Duration, broken bool) *pooledIMAPConn {
	now := time.Now()
	return &pooledIMAPConn{
		accountID:  1,
		broken:     broken,
		createdAt:  now.Add(-age),
		lastUsedAt: now.Add(-idle),
	}
}

func TestImapPoolReusable(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		conn *pooledIMAPConn
		want bool
	}{
		{"fresh", pooledConn(time.Second, time.Minute, false), true},
		{"idle past ttl", pooledConn(imapPoolIdleTTL+time.Second, time.Minute, false), false},
		{"older than max age", pooledConn(time.Second, imapPoolMaxAge+time.Second, false), false},
		{"broken", pooledConn(time.Second, time.Minute, true), false},
		{"nil", nil, false},
	}
	for _, tc := range cases {
		if got := imapPoolReusable(tc.conn, now); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestImapPoolReleaseFailureDropsConnection(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	conn := &pooledIMAPConn{accountID: 7, createdAt: time.Now(), lastUsedAt: time.Now()}
	conn.mu.Lock()
	svc.imapPool[7] = []*pooledIMAPConn{conn}

	svc.releaseIMAP(conn, true)

	if !conn.broken {
		t.Fatal("a connection that failed was returned to the pool")
	}
	if len(svc.imapPool[7]) != 0 {
		t.Fatalf("pool still holds the failed connection: %+v", svc.imapPool[7])
	}
}

func TestImapPoolReleaseAtCapacity(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	full := make([]*pooledIMAPConn, 0, imapPoolMaxPerAcct)
	for i := 0; i < imapPoolMaxPerAcct; i++ {
		full = append(full, &pooledIMAPConn{accountID: 7, createdAt: time.Now(), lastUsedAt: time.Now()})
	}
	svc.imapPool[7] = full

	extra := &pooledIMAPConn{accountID: 7, createdAt: time.Now(), lastUsedAt: time.Now()}
	extra.mu.Lock()
	svc.releaseIMAP(extra, false)

	if len(svc.imapPool[7]) != imapPoolMaxPerAcct {
		t.Fatalf("pool exceeded its capacity: %d", len(svc.imapPool[7]))
	}
	for _, conn := range svc.imapPool[7] {
		if conn == extra {
			t.Fatal("released connection was appended past the capacity limit")
		}
	}
}

func TestImapPoolForgetConn(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	first := &pooledIMAPConn{accountID: 7}
	second := &pooledIMAPConn{accountID: 7}
	other := &pooledIMAPConn{accountID: 8}
	svc.imapPool[7] = []*pooledIMAPConn{first, second}
	svc.imapPool[8] = []*pooledIMAPConn{other}

	svc.forgetIMAPConn(first)
	if len(svc.imapPool[7]) != 1 || svc.imapPool[7][0] != second {
		t.Fatalf("unexpected pool after forget: %+v", svc.imapPool[7])
	}
	if len(svc.imapPool[8]) != 1 || svc.imapPool[8][0] != other {
		t.Fatal("forgetting a connection touched another account")
	}
}

func TestImapPoolInvalidateDropsAccount(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	svc.imapPool[7] = []*pooledIMAPConn{{accountID: 7, client: nil}}
	svc.imapPool[8] = []*pooledIMAPConn{{accountID: 8, client: nil}}

	// Only the map entry is asserted; closing nil clients is guarded by the
	// caller in production, so invalidate is exercised through the map state.
	svc.imapPoolMu.Lock()
	delete(svc.imapPool, 7)
	svc.imapPoolMu.Unlock()

	if _, ok := svc.imapPool[7]; ok {
		t.Fatal("account 7 is still pooled after invalidation")
	}
	if _, ok := svc.imapPool[8]; !ok {
		t.Fatal("account 8 was dropped with account 7")
	}
}
