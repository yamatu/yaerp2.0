package service

import (
	"context"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestConversationGetRejectsAnotherAccount(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT c.id,c.title").WithArgs(int64(2), int64(99)).WillReturnRows(sqlmock.NewRows([]string{"id", "title", "assistant_id", "updated_at", "version"}))
	_, err = (&AIConversationService{db: db}).Get(99, 2)
	if !errors.Is(err, ErrConversationNotFound) {
		t.Fatalf("%v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationUnchangedDoesNotReadHistory(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now().UTC()
	mock.ExpectQuery("SELECT c.id,c.title").WithArgs(int64(2), int64(1)).WillReturnRows(sqlmock.NewRows([]string{"id", "title", "assistant_id", "updated_at", "version"}).AddRow(2, "history", nil, now, now))
	item, err := (&AIConversationService{db: db}).GetIfChanged(1, 2, now.Format(time.RFC3339Nano))
	if err != nil || !item.Unchanged || len(item.Messages) != 0 {
		t.Fatalf("%+v %v", item, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationRequestRetryReturnsOriginalRunWithoutReplay(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("SELECT pg_advisory_xact_lock").WithArgs(int64(1)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT assistant_id,title").WithArgs(int64(2), int64(1)).WillReturnRows(sqlmock.NewRows([]string{"assistant_id", "title", "context"}).AddRow(nil, "history", nil))
	mock.ExpectQuery("SELECT id,conversation_id,assistant_message_id,status").WithArgs(int64(2), "same-request-id").WillReturnRows(sqlmock.NewRows([]string{"id", "conversation_id", "message_id", "status", "activity", "error", "updated_at"}).AddRow(7, 2, "assistant-1", "completed", "", "", time.Now()))
	mock.ExpectRollback()
	run, err := (&AIConversationService{db: db}).Start(1, 2, StartConversationTurn{Prompt: "retry", RequestID: "same-request-id"})
	if err != nil || run.ID != 7 {
		t.Fatalf("%+v %v", run, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationStopIsOwnerAuthorized(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cancelled := false
	s := &AIConversationService{db: db, cancels: map[int64]context.CancelFunc{7: func() { cancelled = true }}}
	mock.ExpectQuery("SELECT r.status").WithArgs(int64(7), int64(2), int64(99)).WillReturnRows(sqlmock.NewRows([]string{"status"}))
	if err := s.Cancel(99, 2, 7); !errors.Is(err, ErrConversationNotFound) || cancelled {
		t.Fatalf("%v cancelled=%v", err, cancelled)
	}
	mock.ExpectQuery("SELECT r.status").WithArgs(int64(7), int64(2), int64(1)).WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("running"))
	if err := s.Cancel(1, 2, 7); err != nil || !cancelled {
		t.Fatalf("%v cancelled=%v", err, cancelled)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationWorkerSurvivesObserverDisconnectAndPersistsResult(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectExec("UPDATE ai_conversation_runs SET status='running'").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectBegin()
	mock.ExpectExec("UPDATE ai_conversation_messages").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversation_runs SET activity").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	mock.ExpectBegin()
	mock.ExpectExec("UPDATE ai_conversation_messages").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversation_runs SET status").WithArgs(int64(7), "completed", "", sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversations").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	reached := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	s := &AIConversationService{db: db, slots: make(chan struct{}, 1), cancels: make(map[int64]context.CancelFunc)}
	s.runAgent = func(ctx context.Context, _ int64, _ int64, _ []ChatMessage, _ *ChatContext, emit AgentEventSink) (*ChatResponse, error) {
		if err := emit(AgentEvent{Type: AgentEventDelta, Delta: "partial"}); err != nil {
			return nil, err
		}
		close(reached)
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return &ChatResponse{Reply: "finished after browser closed"}, nil
	}
	observer, disconnect := context.WithCancel(context.Background())
	worker, cancel := context.WithCancel(context.Background())
	go func() {
		defer close(done)
		s.execute(worker, cancel, 1, nil, ConversationRun{ID: 7, ConversationID: 2, MessageID: "assistant-1"}, nil, nil, DurableChatMessage{ID: "assistant-1", Role: "assistant"})
	}()
	select {
	case <-reached:
	case <-time.After(2 * time.Second):
		t.Fatal("worker never reached provider")
	}
	disconnect()
	if observer.Err() == nil || worker.Err() != nil {
		t.Fatal("observer cancellation must not reach backend-owned worker")
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker failed to complete")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationActionClaimConflictCannotOverwriteAnotherDevice(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("UPDATE ai_conversations SET updated_at").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversation_messages.*idle").WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectRollback()
	err = (&AIConversationService{db: db}).PatchActionState(1, 2, "msg", "apply", "applying", "", "device-claim-id")
	if !errors.Is(err, ErrConversationBusy) {
		t.Fatalf("%v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationIDsAreRandomAndDistinct(t *testing.T) {
	a, err := conversationMessageID()
	if err != nil {
		t.Fatal(err)
	}
	b, err := conversationMessageID()
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != 32 || a == b {
		t.Fatalf("%q %q", a, b)
	}
}

type conversationContextArgument struct{ workbookID int64 }

func (a conversationContextArgument) Match(value driver.Value) bool {
	encoded, ok := value.([]byte)
	if !ok {
		return false
	}
	var context ChatContext
	return json.Unmarshal(encoded, &context) == nil && context.WorkbookID != nil && *context.WorkbookID == a.workbookID
}

func TestConversationContinuesStoredWorkbookContextAcrossDevices(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec("SELECT pg_advisory_xact_lock").WithArgs(int64(1)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT assistant_id,title,context").WithArgs(int64(2), int64(1)).WillReturnRows(sqlmock.NewRows([]string{"assistant_id", "title", "context"}).AddRow(nil, "history", []byte(`{"workbook_id":123,"sheet_ids":[6]}`)))
	mock.ExpectQuery("SELECT id,conversation_id,assistant_message_id,status").WillReturnRows(sqlmock.NewRows([]string{"id", "conversation_id", "message_id", "status", "activity", "error", "updated_at"}))
	mock.ExpectQuery("SELECT COUNT.*ai_conversation_runs").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery("SELECT EXISTS").WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectQuery("SELECT COUNT.*ai_conversation_messages").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery("SELECT payload").WillReturnRows(sqlmock.NewRows([]string{"payload"}))
	for i := 0; i < 2; i++ {
		mock.ExpectExec("INSERT INTO ai_conversation_messages").WillReturnResult(sqlmock.NewResult(0, 1))
	}
	mock.ExpectQuery("INSERT INTO ai_conversation_runs").WillReturnRows(sqlmock.NewRows([]string{"id", "updated_at"}).AddRow(7, time.Now()))
	mock.ExpectExec("UPDATE ai_conversations SET assistant_id").WithArgs(int64(2), nil, "history", conversationContextArgument{123}).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	mock.ExpectExec("UPDATE ai_conversation_runs SET status='running'").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectBegin()
	mock.ExpectExec("UPDATE ai_conversation_messages").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversation_runs SET status").WithArgs(int64(7), "completed", "", sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversations SET updated_at").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	observed := make(chan *ChatContext, 1)
	done := make(chan struct{})
	s := &AIConversationService{db: db, slots: make(chan struct{}, 1), cancels: make(map[int64]context.CancelFunc)}
	s.runAgent = func(_ context.Context, _ int64, _ int64, _ []ChatMessage, context *ChatContext, _ AgentEventSink) (*ChatResponse, error) {
		observed <- context
		return &ChatResponse{Reply: "done"}, nil
	}
	s.SetFinishedCallback(func(_ int64, _ *ChatResponse) { close(done) })
	if _, err := s.Start(1, 2, StartConversationTurn{Prompt: "continue", RequestID: "new-device-request"}); err != nil {
		t.Fatal(err)
	}
	select {
	case context := <-observed:
		if context.WorkbookID == nil || *context.WorkbookID != 123 || len(context.SheetIDs) != 1 || context.SheetIDs[0] != 6 {
			t.Fatalf("%+v", context)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not receive stored context")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not persist completion")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationApprovalWritesSurviveObserverDisconnect(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectExec("UPDATE ai_conversation_runs SET status='running'").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectBegin()
	mock.ExpectExec("UPDATE ai_conversation_messages SET payload").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversation_runs SET activity").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	mock.ExpectExec("UPDATE ai_conversation_messages m SET payload").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectBegin()
	mock.ExpectExec("UPDATE ai_conversation_messages SET payload").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversation_runs SET status").WithArgs(int64(7), "completed", "", sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE ai_conversations SET updated_at").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	reached, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	s := &AIConversationService{db: db, slots: make(chan struct{}, 1), cancels: make(map[int64]context.CancelFunc)}
	s.applyAction = func(ctx context.Context, _ int64, _ *ApprovedConversationAction) (*ChatResponse, error) {
		close(reached)
		select {
		case <-release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return &ChatResponse{Reply: "approved write completed", ChangedSheetIDs: []int64{5}}, nil
	}
	s.runAgent = func(context.Context, int64, int64, []ChatMessage, *ChatContext, AgentEventSink) (*ChatResponse, error) {
		t.Error("manual approval must not invoke another model turn")
		return nil, nil
	}
	s.SetFinishedCallback(func(_ int64, _ *ChatResponse) { close(done) })
	observer, disconnect := context.WithCancel(context.Background())
	worker, cancel := context.WithCancel(context.Background())
	go s.execute(worker, cancel, 1, nil, ConversationRun{ID: 7, ConversationID: 2, MessageID: "receipt"}, nil, nil, DurableChatMessage{ID: "receipt", Role: "assistant"}, &ApprovedConversationAction{MessageID: "source-plan", Kind: "apply", claimID: "server-claim"})
	select {
	case <-reached:
	case <-time.After(2 * time.Second):
		t.Fatal("approval worker did not start")
	}
	disconnect()
	if observer.Err() == nil || worker.Err() != nil {
		t.Fatal("closing the browser must not cancel the approved write")
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("approval completion was not persisted")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestConversationRestartInterruptsWithoutLaunchingReplay(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectExec("UPDATE ai_conversation_runs SET status='interrupted'").WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectExec("UPDATE ai_conversation_messages m SET payload=payload").WillReturnResult(sqlmock.NewResult(0, 1))
	s, err := NewAIConversationService(db, nil)
	if err != nil || len(s.cancels) != 0 {
		t.Fatalf("%v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
