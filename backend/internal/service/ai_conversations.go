package service

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

var ErrConversationNotFound = errors.New("对话不存在或无权访问")
var ErrConversationBusy = errors.New("此对话正在处理，请等待完成或显式停止；同一账号最多同时运行两个对话")

// DurableChatMessage deliberately matches the existing panel's persisted shape.
// Only the owner can read it; pending changes still require explicit approval.
type DurableChatMessage struct {
	ID                string                 `json:"id"`
	Role              string                 `json:"role"`
	Content           string                 `json:"content"`
	CreatedAt         int64                  `json:"createdAt"`
	PendingOperations []SpreadsheetOperation `json:"pendingOperations,omitempty"`
	PendingERPPlan    *ERPPendingPlan        `json:"pendingERPPlan,omitempty"`
	ToolTraces        []ChatToolTrace        `json:"toolTraces,omitempty"`
	TouchedSheetIDs   []int64                `json:"touchedSheetIds,omitempty"`
	ApplyState        string                 `json:"applyState,omitempty"`
	ApplyError        string                 `json:"applyError,omitempty"`
	ERPApplyState     string                 `json:"erpApplyState,omitempty"`
	ERPApplyError     string                 `json:"erpApplyError,omitempty"`
}

type ConversationRun struct {
	ID             int64         `json:"id"`
	ConversationID int64         `json:"conversation_id"`
	MessageID      string        `json:"message_id"`
	Status         string        `json:"status"`
	Activity       string        `json:"activity"`
	Error          string        `json:"error,omitempty"`
	Result         *ChatResponse `json:"result,omitempty"`
	UpdatedAt      time.Time     `json:"updated_at"`
}

type AIConversation struct {
	ID          int64                `json:"id"`
	Title       string               `json:"title"`
	AssistantID *int64               `json:"assistant_id"`
	UpdatedAt   time.Time            `json:"updated_at"`
	Messages    []DurableChatMessage `json:"messages,omitempty"`
	LastRun     *ConversationRun     `json:"last_run,omitempty"`
	Version     string               `json:"version,omitempty"`
	Unchanged   bool                 `json:"unchanged,omitempty"`
}

type ApprovedConversationAction struct {
	MessageID    string `json:"message_id"`
	Kind         string `json:"kind"`
	ContinueTask bool   `json:"continue_task"`
	claimID      string
	operations   []SpreadsheetOperation
	erpPlan      *ERPPendingPlan
}

type StartConversationTurn struct {
	Approval    *ApprovedConversationAction `json:"approval,omitempty"`
	Prompt      string                      `json:"prompt"`
	RequestID   string                      `json:"request_id"`
	AssistantID *int64                      `json:"assistant_id"`
	Context     *ChatContext                `json:"context"`
}

// AIConversationService owns a bounded set of workers independent of HTTP
// request contexts. Disconnecting a browser ONLY stops observation, never the
// agent. Explicit cancellation is a separate, owner-authorized operation.
// This deployment has a single backend process; on restart unfinished jobs are
// marked interrupted, NOT replayed (replay could duplicate committed writes).
type AIConversationService struct {
	db       *sql.DB
	ai       *AIService
	mu       sync.Mutex
	cancels  map[int64]context.CancelFunc
	slots    chan struct{}
	finished func(userID int64, result *ChatResponse)
	// Test seam for the worker; production uses AIService.RunAgentStream.
	runAgent    func(context.Context, int64, int64, []ChatMessage, *ChatContext, AgentEventSink) (*ChatResponse, error)
	applyAction func(context.Context, int64, *ApprovedConversationAction) (*ChatResponse, error)
}

func NewAIConversationService(db *sql.DB, ai *AIService) (*AIConversationService, error) {
	_, err := db.Exec(`UPDATE ai_conversation_runs SET status='interrupted',
		error='后端已重启，本次执行中断；已提交的操作可能已生效，请核对后再继续，系统不会自动重放写入。', updated_at=NOW()
		WHERE status IN ('queued','running')`)
	if err != nil {
		return nil, err
	}
	_, err = db.Exec(`UPDATE ai_conversation_messages m SET payload=payload
		|| CASE WHEN payload->>'applyState'='applying' THEN jsonb_build_object('applyState','failed','applyError','后端重启，结果不确定，请核对后生成新方案') ELSE '{}'::jsonb END
		|| CASE WHEN payload->>'erpApplyState'='applying' THEN jsonb_build_object('erpApplyState','failed','erpApplyError','后端重启，结果不确定，请核对后生成新方案') ELSE '{}'::jsonb END
		WHERE EXISTS(SELECT 1 FROM ai_conversation_runs r WHERE r.conversation_id=m.conversation_id AND r.status='interrupted')
		AND (payload->>'applyState'='applying' OR payload->>'erpApplyState'='applying')`)
	if err != nil {
		return nil, err
	}
	return &AIConversationService{db: db, ai: ai, cancels: make(map[int64]context.CancelFunc), slots: make(chan struct{}, 4)}, nil
}

func (s *AIConversationService) SetFinishedCallback(callback func(int64, *ChatResponse)) {
	s.finished = callback
}

func conversationMessageID() (string, error) {
	var data [16]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(data[:]), nil
}

func (s *AIConversationService) Create(userID int64, title string, assistantID *int64, seed []DurableChatMessage) (*AIConversation, error) {
	if len(seed) > 200 {
		return nil, fmt.Errorf("旧对话最多导入 200 条消息")
	}
	if len([]rune(title)) > 80 {
		title = string([]rune(title)[:80])
	}
	if strings.TrimSpace(title) == "" {
		title = "新对话"
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var id int64
	if err := tx.QueryRow(`INSERT INTO ai_conversations(user_id,title,assistant_id) VALUES($1,$2,$3) RETURNING id`, userID, title, assistantID).Scan(&id); err != nil {
		return nil, err
	}
	totalChars := 0
	for _, old := range seed {
		totalChars += len(old.Content)
		if totalChars > 2*1024*1024 {
			return nil, fmt.Errorf("导入对话过大")
		}
		if (old.Role != "user" && old.Role != "assistant") || len(old.Content) > 120000 {
			return nil, fmt.Errorf("旧对话消息无效")
		}
		msgID, err := conversationMessageID()
		if err != nil {
			return nil, err
		}
		// Import text only: stale browser plans must not become executable again.
		msg := DurableChatMessage{ID: msgID, Role: old.Role, Content: old.Content, CreatedAt: old.CreatedAt}
		if msg.CreatedAt <= 0 {
			msg.CreatedAt = time.Now().UnixMilli()
		}
		payload, _ := json.Marshal(msg)
		if _, err := tx.Exec(`INSERT INTO ai_conversation_messages(id,conversation_id,role,payload) VALUES($1,$2,$3,$4)`, msg.ID, id, msg.Role, payload); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.Get(userID, id)
}

func (s *AIConversationService) List(userID int64) ([]AIConversation, error) {
	rows, err := s.db.Query(`SELECT id,title,assistant_id,updated_at FROM ai_conversations WHERE user_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]AIConversation, 0)
	for rows.Next() {
		var item AIConversation
		if err := rows.Scan(&item.ID, &item.Title, &item.AssistantID, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *AIConversationService) Get(userID, id int64) (*AIConversation, error) {
	return s.GetIfChanged(userID, id, "")
}

func (s *AIConversationService) GetIfChanged(userID, id int64, version string) (*AIConversation, error) {
	var item AIConversation
	var versionTime time.Time
	err := s.db.QueryRow(`SELECT c.id,c.title,c.assistant_id,c.updated_at,
		GREATEST(c.updated_at,COALESCE((SELECT MAX(r.updated_at) FROM ai_conversation_runs r WHERE r.conversation_id=c.id),c.updated_at))
		FROM ai_conversations c WHERE c.id=$1 AND c.user_id=$2`, id, userID).Scan(&item.ID, &item.Title, &item.AssistantID, &item.UpdatedAt, &versionTime)
	if err == sql.ErrNoRows {
		return nil, ErrConversationNotFound
	}
	if err != nil {
		return nil, err
	}
	item.Version = versionTime.UTC().Format(time.RFC3339Nano)
	if version != "" && item.Version == version {
		item.Unchanged = true
		return &item, nil
	}
	rows, err := s.db.Query(`SELECT payload FROM ai_conversation_messages WHERE conversation_id=$1 ORDER BY seq`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	item.Messages = make([]DurableChatMessage, 0)
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			return nil, err
		}
		var msg DurableChatMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			return nil, err
		}
		item.Messages = append(item.Messages, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var run ConversationRun
	var result []byte
	err = s.db.QueryRow(`SELECT id,conversation_id,assistant_message_id,status,activity,error,result,updated_at FROM ai_conversation_runs WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1`, id).
		Scan(&run.ID, &run.ConversationID, &run.MessageID, &run.Status, &run.Activity, &run.Error, &result, &run.UpdatedAt)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if err == nil {
		if len(result) > 0 {
			if err := json.Unmarshal(result, &run.Result); err != nil {
				return nil, err
			}
		}
		item.LastRun = &run
	}
	return &item, nil
}

func (s *AIConversationService) Delete(userID, id int64) error {
	// Use the same lock as Start: a concurrent start must not lose its durable
	// record after a delete checked a stale no-active-run snapshot.
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return err
	}
	var owned int64
	if err := tx.QueryRow(`SELECT id FROM ai_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID).Scan(&owned); err != nil {
		if err == sql.ErrNoRows {
			return ErrConversationNotFound
		}
		return err
	}
	var active bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM ai_conversation_runs WHERE conversation_id=$1 AND status IN ('queued','running'))`, id).Scan(&active); err != nil {
		return err
	}
	if active {
		return ErrConversationBusy
	}
	if _, err := tx.Exec(`DELETE FROM ai_conversations WHERE id=$1 AND user_id=$2`, id, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *AIConversationService) Start(userID, conversationID int64, request StartConversationTurn) (*ConversationRun, error) {
	if strings.TrimSpace(request.Prompt) == "" || len(request.Prompt) > 120000 || len(request.RequestID) < 8 || len(request.RequestID) > 100 {
		return nil, fmt.Errorf("prompt/request_id 无效")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Serializes starts across conversations of the same account, not just one
	// browser. A retry with the same request_id returns the original run.
	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return nil, err
	}
	var assistantID *int64
	var title string
	var storedContext []byte
	err = tx.QueryRow(`SELECT assistant_id,title,context FROM ai_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE`, conversationID, userID).Scan(&assistantID, &title, &storedContext)
	if err == sql.ErrNoRows {
		return nil, ErrConversationNotFound
	}
	if err != nil {
		return nil, err
	}
	var existing ConversationRun
	err = tx.QueryRow(`SELECT id,conversation_id,assistant_message_id,status,activity,error,updated_at FROM ai_conversation_runs WHERE conversation_id=$1 AND request_id=$2`, conversationID, request.RequestID).
		Scan(&existing.ID, &existing.ConversationID, &existing.MessageID, &existing.Status, &existing.Activity, &existing.Error, &existing.UpdatedAt)
	if err == nil {
		return &existing, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}
	var active, totalMessages int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM ai_conversation_runs r JOIN ai_conversations c ON c.id=r.conversation_id WHERE c.user_id=$1 AND r.status IN ('queued','running')`, userID).Scan(&active); err != nil {
		return nil, err
	}
	if active >= 2 {
		return nil, ErrConversationBusy
	}
	var busy bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM ai_conversation_runs WHERE conversation_id=$1 AND status IN ('queued','running'))`, conversationID).Scan(&busy); err != nil {
		return nil, err
	}
	if busy {
		return nil, ErrConversationBusy
	}
	if err := tx.QueryRow(`SELECT COUNT(*) FROM ai_conversation_messages WHERE conversation_id=$1`, conversationID).Scan(&totalMessages); err != nil {
		return nil, err
	}
	if totalMessages > 1998 {
		return nil, fmt.Errorf("对话已达到上限，请新建对话")
	}
	if action := request.Approval; action != nil {
		if action.Kind != "apply" && action.Kind != "erp" {
			return nil, fmt.Errorf("无效的确认方案类型")
		}
		var payload []byte
		if err := tx.QueryRow(`SELECT payload FROM ai_conversation_messages WHERE conversation_id=$1 AND id=$2 AND role='assistant' FOR UPDATE`, conversationID, action.MessageID).Scan(&payload); err != nil {
			return nil, ErrConversationNotFound
		}
		var source DurableChatMessage
		if err := json.Unmarshal(payload, &source); err != nil {
			return nil, err
		}
		field := "applyState"
		if action.Kind == "apply" {
			if len(source.PendingOperations) == 0 || (source.ApplyState != "" && source.ApplyState != "idle") {
				return nil, ErrConversationBusy
			}
			action.operations = source.PendingOperations
		} else {
			field = "erpApplyState"
			if source.PendingERPPlan == nil || (source.ERPApplyState != "" && source.ERPApplyState != "idle") {
				return nil, ErrConversationBusy
			}
			action.erpPlan = source.PendingERPPlan
		}
		claimID, err := conversationMessageID()
		if err != nil {
			return nil, err
		}
		action.claimID = claimID
		patch, _ := json.Marshal(map[string]string{field: "applying", field + "Claim": claimID})
		if _, err := tx.Exec(`UPDATE ai_conversation_messages SET payload=payload || $2::jsonb WHERE id=$1`, action.MessageID, patch); err != nil {
			return nil, err
		}
	}
	if request.AssistantID != nil {
		assistantID = request.AssistantID
	}
	if request.Context == nil && len(storedContext) > 0 {
		if err := json.Unmarshal(storedContext, &request.Context); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(`SELECT payload FROM ai_conversation_messages WHERE conversation_id=$1 ORDER BY seq DESC LIMIT 40`, conversationID)
	if err != nil {
		return nil, err
	}
	history := make([]ChatMessage, 0, 41)
	for rows.Next() {
		var payload []byte
		if err := rows.Scan(&payload); err != nil {
			rows.Close()
			return nil, err
		}
		var msg DurableChatMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			rows.Close()
			return nil, err
		}
		content := msg.Content
		if len(content) > 120000 {
			content = strings.ToValidUTF8(content[:120000], "")
		}
		history = append(history, ChatMessage{Role: msg.Role, Content: content})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for i, j := 0, len(history)-1; i < j; i, j = i+1, j-1 {
		history[i], history[j] = history[j], history[i]
	}
	history = append(history, ChatMessage{Role: "user", Content: request.Prompt})
	// Keep provider requests bounded without deleting the durable history.
	totalChars := 0
	for _, message := range history {
		totalChars += len(message.Content)
	}
	for totalChars > 2*1024*1024 && len(history) > 1 {
		totalChars -= len(history[0].Content)
		history = history[1:]
	}
	userMessageID, err := conversationMessageID()
	if err != nil {
		return nil, err
	}
	assistantMessageID, err := conversationMessageID()
	if err != nil {
		return nil, err
	}
	userMsg := DurableChatMessage{ID: userMessageID, Role: "user", Content: request.Prompt, CreatedAt: time.Now().UnixMilli()}
	assistantMsg := DurableChatMessage{ID: assistantMessageID, Role: "assistant", Content: "", CreatedAt: time.Now().UnixMilli()}
	for _, msg := range []DurableChatMessage{userMsg, assistantMsg} {
		payload, _ := json.Marshal(msg)
		if _, err := tx.Exec(`INSERT INTO ai_conversation_messages(id,conversation_id,role,payload) VALUES($1,$2,$3,$4)`, msg.ID, conversationID, msg.Role, payload); err != nil {
			return nil, err
		}
	}
	var run ConversationRun
	err = tx.QueryRow(`INSERT INTO ai_conversation_runs(conversation_id,request_id,assistant_message_id,status) VALUES($1,$2,$3,'queued') RETURNING id,updated_at`, conversationID, request.RequestID, assistantMessageID).Scan(&run.ID, &run.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if title == "新对话" {
		runes := []rune(strings.TrimSpace(request.Prompt))
		if len(runes) > 40 {
			runes = runes[:40]
		}
		title = string(runes)
	}
	var contextJSON any
	if request.Context != nil {
		encoded, err := json.Marshal(request.Context)
		if err != nil {
			return nil, err
		}
		contextJSON = encoded
	}
	if _, err := tx.Exec(`UPDATE ai_conversations SET assistant_id=$2,title=$3,context=$4,updated_at=NOW() WHERE id=$1`, conversationID, assistantID, title, contextJSON); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	run.ConversationID, run.MessageID, run.Status = conversationID, assistantMessageID, "queued"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	s.mu.Lock()
	s.cancels[run.ID] = cancel
	s.mu.Unlock()
	go s.execute(ctx, cancel, userID, assistantID, run, history, request.Context, assistantMsg, request.Approval)
	return &run, nil
}

func (s *AIConversationService) Cancel(userID, conversationID, runID int64) error {
	var status string
	err := s.db.QueryRow(`SELECT r.status FROM ai_conversation_runs r JOIN ai_conversations c ON c.id=r.conversation_id WHERE r.id=$1 AND c.id=$2 AND c.user_id=$3`, runID, conversationID, userID).Scan(&status)
	if err == sql.ErrNoRows {
		return ErrConversationNotFound
	}
	if err != nil {
		return err
	}
	if status != "running" && status != "queued" {
		return nil
	}
	s.mu.Lock()
	cancel := s.cancels[runID]
	s.mu.Unlock()
	if cancel == nil {
		return fmt.Errorf("执行进程不可用，请刷新查看中断状态")
	}
	cancel()
	return nil
}

func (s *AIConversationService) saveProgress(run ConversationRun, msg DurableChatMessage, activity string) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE ai_conversation_messages SET payload=$2 WHERE id=$1`, run.MessageID, payload); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE ai_conversation_runs SET activity=$2,updated_at=NOW() WHERE id=$1`, run.ID, activity); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *AIConversationService) execute(ctx context.Context, cancel context.CancelFunc, userID int64, assistantID *int64, run ConversationRun, history []ChatMessage, chatContext *ChatContext, msg DurableChatMessage, approvals ...*ApprovedConversationAction) {
	defer cancel()
	defer func() { s.mu.Lock(); delete(s.cancels, run.ID); s.mu.Unlock() }()
	var result *ChatResponse
	var runErr error
	var action *ApprovedConversationAction
	if len(approvals) > 0 {
		action = approvals[0]
	}
	actionStarted, actionFinished := false, false
	// Always finalize, including cancellation while waiting for a worker slot.
	defer func() {
		if failure := recover(); failure != nil {
			runErr = fmt.Errorf("智能体异常中断：%v", failure)
		}
		if action != nil && !actionFinished {
			state := "idle"
			if actionStarted {
				state = "failed"
			}
			if err := s.finishApprovedAction(userID, run.ConversationID, action, state, "任务中断，请核对已执行操作"); err != nil {
				log.Printf("finish approved AI action: %v", err)
			}
		}
		s.finish(run, msg, result, runErr)
		if result != nil && s.finished != nil {
			s.finished(userID, result)
		}
	}()
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-ctx.Done():
		runErr = ctx.Err()
		return
	}
	if _, runErr = s.db.Exec(`UPDATE ai_conversation_runs SET status='running',updated_at=NOW() WHERE id=$1`, run.ID); runErr != nil {
		return
	}
	id := int64(0)
	if assistantID != nil {
		id = *assistantID
	}
	var receipt *ChatResponse
	if action != nil {
		msg.Content = "正在后台执行已确认的方案…"
		if runErr = s.saveProgress(run, msg, "执行已确认方案"); runErr != nil {
			return
		}
		if ctx.Err() != nil {
			runErr = ctx.Err()
			return
		}
		actionStarted = true
		applier := s.applyAction
		if applier == nil {
			applier = s.applyApprovedAction
		}
		receipt, runErr = applier(ctx, userID, action)
		result = receipt
		state, detail := "applied", ""
		if runErr != nil {
			state, detail = "failed", runErr.Error()
		}
		if err := s.finishApprovedAction(userID, run.ConversationID, action, state, detail); err != nil {
			runErr = err
			return
		}
		actionFinished = true
		if runErr != nil || !action.ContinueTask {
			return
		}
		if receipt != nil {
			msg.Content = receipt.Reply + "\n\n"
			history = append(history, ChatMessage{Role: "assistant", Content: receipt.Reply}, ChatMessage{Role: "user", Content: "方案已由后端执行，禁止重复执行同一方案。请继续完成剩余任务，下一项需要确认的操作请给出方案。"})
		}
		if ctx.Err() != nil {
			runErr = ctx.Err()
			return
		}
	}
	lastSave := time.Time{}
	var eventMu sync.Mutex
	runner := s.runAgent
	if runner == nil {
		runner = s.ai.RunAgentStream
	}
	result, runErr = runner(ctx, userID, id, history, chatContext, func(event AgentEvent) error {
		eventMu.Lock()
		defer eventMu.Unlock()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		activity := "智能体正在分析"
		if event.Delta != "" {
			msg.Content += event.Delta
		}
		if event.Tool != nil {
			activity = "正在" + event.Tool.Label
			if event.Type == AgentEventToolEnd {
				activity = "已完成" + event.Tool.Label
				msg.ToolTraces = append(msg.ToolTraces, ChatToolTrace{Name: event.Tool.Name, Status: event.Tool.Status, Summary: event.Tool.Summary, Data: event.Tool.Data, TouchedSheetIDs: event.Tool.TouchedSheetIDs})
			}
		}
		if event.Type == AgentEventDelta {
			activity = "正在生成回答"
		}
		if time.Since(lastSave) < time.Second && event.Type == AgentEventDelta {
			return nil
		}
		lastSave = time.Now()
		return s.saveProgress(run, msg, activity)
	})
	if receipt != nil {
		if result == nil {
			result = receipt
		} else {
			result.Reply = receipt.Reply + "\n\n" + result.Reply
			result.ChangedSheetIDs = uniquePositiveInt64s(append(receipt.ChangedSheetIDs, result.ChangedSheetIDs...), 10000)
			result.ResourcesChanged = result.ResourcesChanged || receipt.ResourcesChanged
		}
	}
}

func (s *AIConversationService) applyApprovedAction(ctx context.Context, userID int64, action *ApprovedConversationAction) (*ChatResponse, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if action.Kind == "erp" {
		applied, err := s.ai.ApplyERPPlan(userID, action.erpPlan.PlanToken)
		if err != nil {
			return &ChatResponse{Reply: "ERP 执行未完成，请核对操作记录。", ResourcesChanged: true}, err
		}
		return &ChatResponse{Reply: applied.Message + "\n\n" + applied.NextStep, ResourcesChanged: applied.ResourcesChanged}, nil
	}
	changed, err := s.ai.executeSpreadsheetOperationsContext(ctx, userID, action.operations)
	if err != nil {
		// Earlier operations may have committed before a later one failed.
		for _, op := range action.operations {
			changed = append(changed, op.SheetID)
		}
		return &ChatResponse{Reply: "方案执行未完成，已提交的操作可能已生效，请核对数据；系统不会重放此方案。", ChangedSheetIDs: uniquePositiveInt64s(changed, 10000)}, err
	}
	return &ChatResponse{Reply: fmt.Sprintf("已执行 %d 项表格修改。", len(action.operations)), ChangedSheetIDs: changed, TouchedSheetIDs: changed}, nil
}

func (s *AIConversationService) finishApprovedAction(userID, conversationID int64, action *ApprovedConversationAction, state, detail string) error {
	field, errorField := "applyState", "applyError"
	if action.Kind == "erp" {
		field, errorField = "erpApplyState", "erpApplyError"
	}
	patch, _ := json.Marshal(map[string]string{field: state, errorField: detail})
	result, err := s.db.Exec(`UPDATE ai_conversation_messages m SET payload=payload || $4::jsonb FROM ai_conversations c
		WHERE m.conversation_id=c.id AND c.id=$1 AND c.user_id=$2 AND m.id=$3 AND m.payload->>$5::text=$6 AND m.payload->>$7::text='applying'`, conversationID, userID, action.MessageID, patch, field+"Claim", action.claimID, field)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count != 1 {
		return ErrConversationBusy
	}
	return nil
}

func (s *AIConversationService) finish(run ConversationRun, msg DurableChatMessage, result *ChatResponse, runErr error) {
	status, detail := "completed", ""
	if result != nil {
		msg.Content = result.Reply
		msg.PendingOperations = result.PendingOperations
		msg.PendingERPPlan = result.PendingERPPlan
		msg.ToolTraces = result.ToolTraces
		msg.TouchedSheetIDs = result.TouchedSheetIDs
		msg.ApplyState = "idle"
		msg.ERPApplyState = "idle"
	}
	if runErr != nil {
		status, detail = "failed", runErr.Error()
		if errors.Is(runErr, context.Canceled) {
			status = "cancelled"
			detail = "用户已停止执行，已提交的操作可能已生效。"
		}
		msg.Content += "\n\n执行未完成：" + detail
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		log.Printf("persist AI message: %v", err)
		return
	}
	var resultJSON any
	if result != nil {
		encoded, err := json.Marshal(result)
		if err != nil {
			log.Printf("persist AI result: %v", err)
			return
		}
		resultJSON = encoded
	}
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("finish AI conversation: %v", err)
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE ai_conversation_messages SET payload=$2 WHERE id=$1`, run.MessageID, payload); err == nil {
		_, err = tx.Exec(`UPDATE ai_conversation_runs SET status=$2,error=$3,result=$4,activity='',updated_at=NOW() WHERE id=$1`, run.ID, status, detail, resultJSON)
	}
	if err == nil {
		_, err = tx.Exec(`UPDATE ai_conversations SET updated_at=NOW() WHERE id=$1`, run.ConversationID)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		log.Printf("finish AI conversation: %v", err)
	}
}

// PatchActionState is a server-side claim/finish operation, shared by devices.
// An applying/applied action cannot be claimed again just by reopening history.
func (s *AIConversationService) PatchActionState(userID, conversationID int64, messageID, kind, state, detail, claimID string) error {
	if (kind != "apply" && kind != "erp") || (state != "applying" && state != "applied" && state != "failed") {
		return fmt.Errorf("无效的操作状态")
	}
	if len(claimID) < 8 || len(claimID) > 100 {
		return fmt.Errorf("无效的操作领取标识")
	}
	field, errorField := "applyState", "applyError"
	if kind == "erp" {
		field, errorField = "erpApplyState", "erpApplyError"
	}
	claimField := field + "Claim"
	patch, _ := json.Marshal(map[string]string{field: state, errorField: detail, claimField: claimID})
	query := `UPDATE ai_conversation_messages m SET payload=payload || $4::jsonb FROM ai_conversations c WHERE m.conversation_id=c.id AND c.id=$1 AND c.user_id=$2 AND m.id=$3 AND m.role='assistant'`
	if kind == "apply" {
		query += ` AND CASE WHEN jsonb_typeof(m.payload->'pendingOperations')='array' THEN jsonb_array_length(m.payload->'pendingOperations')>0 ELSE false END`
	} else {
		query += ` AND jsonb_typeof(m.payload->'pendingERPPlan')='object'`
	}
	if state == "applying" {
		query += ` AND COALESCE(m.payload->>'` + field + `','idle') = 'idle' AND $5::text <> ''`
	}
	if state != "applying" {
		query += ` AND m.payload->>'` + claimField + `'=$5 AND m.payload->>'` + field + `'='applying'`
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Consistent conversation -> message lock order with Start/approvals.
	owner, err := tx.Exec(`UPDATE ai_conversations SET updated_at=NOW() WHERE id=$1 AND user_id=$2`, conversationID, userID)
	if err != nil {
		return err
	}
	owned, _ := owner.RowsAffected()
	if owned == 0 {
		return ErrConversationNotFound
	}
	result, err := tx.Exec(query, conversationID, userID, messageID, patch, claimID)
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return ErrConversationBusy
	}
	return tx.Commit()
}
