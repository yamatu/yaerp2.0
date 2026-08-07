package repo

import (
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/lib/pq"
)

type mailAccountResult int64

func (result mailAccountResult) LastInsertId() (int64, error) { return 0, nil }
func (result mailAccountResult) RowsAffected() (int64, error) { return int64(result), nil }

type defaultMailAccountState struct {
	defaultID   int64
	targetID    int64
	callQueries []string
}

func (state *defaultMailAccountState) Exec(query string, args ...any) (sql.Result, error) {
	normalized := strings.Join(strings.Fields(query), " ")
	state.callQueries = append(state.callQueries, normalized)
	switch {
	case strings.Contains(normalized, "is_default=FALSE"):
		state.defaultID = 0
		return mailAccountResult(1), nil
	case strings.Contains(normalized, "is_default=TRUE"):
		if state.defaultID != 0 {
			return nil, errors.New("duplicate default mail account")
		}
		accountID, _ := args[0].(int64)
		if accountID != state.targetID {
			return mailAccountResult(0), nil
		}
		state.defaultID = accountID
		return mailAccountResult(1), nil
	default:
		return nil, errors.New("unexpected mail account update")
	}
}

func TestNonNilMailAddresses(t *testing.T) {
	empty := nonNilMailAddresses(nil)
	if empty == nil {
		t.Fatal("expected nil forwarding addresses to become a non-nil empty slice")
	}
	if len(empty) != 0 {
		t.Fatalf("expected empty forwarding addresses, got %v", empty)
	}
	value, err := pq.Array(empty).Value()
	if err != nil {
		t.Fatalf("encode forwarding addresses: %v", err)
	}
	if value != "{}" {
		t.Fatalf("expected PostgreSQL empty array, got %#v", value)
	}

	addresses := []string{"notify@example.com"}
	result := nonNilMailAddresses(addresses)
	if len(result) != 1 || result[0] != addresses[0] {
		t.Fatalf("expected configured forwarding addresses to be preserved, got %v", result)
	}
}

func TestSwitchDefaultMailAccountClearsExistingDefaultFirst(t *testing.T) {
	state := &defaultMailAccountState{defaultID: 11, targetID: 22}

	if err := switchDefaultMailAccount(state, 7, 22); err != nil {
		t.Fatalf("switch default mail account: %v", err)
	}
	if state.defaultID != 22 {
		t.Fatalf("expected account 22 to be default, got %d", state.defaultID)
	}
	if len(state.callQueries) != 2 {
		t.Fatalf("expected two ordered updates, got %d", len(state.callQueries))
	}
	if !strings.Contains(state.callQueries[0], "is_default=FALSE") ||
		!strings.Contains(state.callQueries[1], "is_default=TRUE") {
		t.Fatalf("expected old default to be cleared before setting the new default: %v", state.callQueries)
	}
}

func TestSwitchDefaultMailAccountRejectsMissingTarget(t *testing.T) {
	state := &defaultMailAccountState{defaultID: 11, targetID: 22}

	err := switchDefaultMailAccount(state, 7, 33)
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected sql.ErrNoRows, got %v", err)
	}
}

func TestCompleteBulkRecipientSQLTypesStatusParameters(t *testing.T) {
	if strings.Count(completeBulkRecipientSQL, "$2::VARCHAR(16)") != 5 {
		t.Fatalf("expected every status parameter use to be explicitly typed: %s", completeBulkRecipientSQL)
	}
	if !strings.Contains(completeBulkRecipientSQL, "$3::TEXT") || !strings.Contains(completeBulkRecipientSQL, "$4::TEXT") {
		t.Fatalf("expected message parameters to be explicitly typed: %s", completeBulkRecipientSQL)
	}
}
