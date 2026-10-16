package service

import (
	"testing"
	"time"
)

func idleConn(accountID int64, route string, idle, age time.Duration) *pooledIMAPConn {
	now := time.Now()
	return &pooledIMAPConn{accountID: accountID, routeKey: route, createdAt: now.Add(-age), lastUsedAt: now.Add(-idle)}
}

func TestImapPoolReusable(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		conn *pooledIMAPConn
		want bool
	}{
		{"fresh", idleConn(1, "direct", time.Second, time.Minute), true},
		{"idle past ttl", idleConn(1, "direct", imapPoolIdleTTL+time.Second, time.Minute), false},
		{"older than max age", idleConn(1, "direct", time.Second, imapPoolMaxAge+time.Second), false},
		{"nil", nil, false},
	}
	for _, tc := range cases {
		if got := imapPoolReusable(tc.conn, now); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

// A leased connection must leave the pool, otherwise two concurrent requests
// would issue commands on the same IMAP socket.
func TestImapPoolTakeRemovesLeasedConnection(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	first := idleConn(7, "direct", time.Second, time.Minute)
	second := idleConn(7, "direct", time.Second, time.Minute)
	svc.imapPool[7] = []*pooledIMAPConn{first, second}

	taken := svc.takePooledIMAP(7, "direct")
	if taken != first {
		t.Fatalf("expected the first idle connection, got %+v", taken)
	}
	if len(svc.imapPool[7]) != 1 || svc.imapPool[7][0] != second {
		t.Fatalf("leased connection is still pooled: %+v", svc.imapPool[7])
	}
	if svc.takePooledIMAP(7, "direct") != second || svc.takePooledIMAP(7, "direct") != nil {
		t.Fatal("pool handed out a connection twice")
	}
}

func TestImapPoolSkipsConnectionsFromAnotherRoute(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	svc.imapPool[7] = []*pooledIMAPConn{idleConn(7, "socks5|proxy|7890", time.Second, time.Minute)}

	if conn := svc.takePooledIMAP(7, "direct"); conn != nil {
		t.Fatal("a connection dialled through the proxy was reused for a direct route")
	}
	if len(svc.imapPool[7]) != 0 {
		t.Fatal("the mismatched connection should have been dropped")
	}
}

func TestImapPoolReleaseFailureDropsConnection(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	svc.releaseIMAP(idleConn(7, "direct", 0, 0), true)
	if len(svc.imapPool[7]) != 0 {
		t.Fatalf("a failed connection was returned to the pool: %+v", svc.imapPool[7])
	}
}

func TestImapPoolReleaseAtCapacity(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	for i := 0; i < imapPoolMaxPerAcct; i++ {
		svc.releaseIMAP(idleConn(7, "direct", 0, 0), false)
	}
	extra := idleConn(7, "direct", 0, 0)
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

func TestImapPoolInvalidateRejectsLeasedConnection(t *testing.T) {
	svc := &MailService{imapPool: map[int64][]*pooledIMAPConn{}}
	leased := idleConn(7, "direct", 0, 0)
	svc.imapPool[8] = []*pooledIMAPConn{idleConn(8, "direct", 0, 0)}

	svc.invalidateIMAPPool(7)
	svc.releaseIMAP(leased, false)

	if len(svc.imapPool[7]) != 0 {
		t.Fatal("a connection leased before invalidation was returned to the pool")
	}
	if len(svc.imapPool[8]) != 1 {
		t.Fatal("invalidating one account touched another")
	}
}
