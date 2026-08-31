package repo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lib/pq"

	"yaerp/internal/model"
)

type AutomationRepo struct {
	db *sql.DB
}

func NewAutomationRepo(db *sql.DB) *AutomationRepo {
	return &AutomationRepo{db: db}
}

func (r *AutomationRepo) CreateRule(rule *model.AutomationRule) error {
	values, err := automationRuleValues(rule)
	if err != nil {
		return err
	}
	return r.db.QueryRow(
		`INSERT INTO automation_rules
		 (name, description, owner_id, sheet_id, trigger_type, watched_columns, cron_expr,
		  timezone, condition_logic, conditions, approval_steps, approval_ranges, actions, hold_changes, enabled)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		 RETURNING id, created_at, updated_at`,
		rule.Name, rule.Description, rule.OwnerID, rule.SheetID, rule.TriggerType,
		values.watchedColumns, rule.CronExpr, rule.Timezone, rule.ConditionLogic,
		values.conditions, values.approvalSteps, values.approvalRanges, values.actions, rule.HoldChanges, rule.Enabled,
	).Scan(&rule.ID, &rule.CreatedAt, &rule.UpdatedAt)
}

func (r *AutomationRepo) UpdateRule(rule *model.AutomationRule) error {
	values, err := automationRuleValues(rule)
	if err != nil {
		return err
	}
	result, err := r.db.Exec(
		`UPDATE automation_rules SET
		 name=$1, description=$2, owner_id=$3, sheet_id=$4, trigger_type=$5,
		 watched_columns=$6, cron_expr=$7, timezone=$8, condition_logic=$9,
		 conditions=$10, approval_steps=$11, approval_ranges=$12, actions=$13,
		 hold_changes=$14, enabled=$15, updated_at=NOW()
		 WHERE id=$16`,
		rule.Name, rule.Description, rule.OwnerID, rule.SheetID, rule.TriggerType,
		values.watchedColumns, rule.CronExpr, rule.Timezone, rule.ConditionLogic,
		values.conditions, values.approvalSteps, values.approvalRanges, values.actions,
		rule.HoldChanges, rule.Enabled, rule.ID,
	)
	if err != nil {
		return fmt.Errorf("update automation rule: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *AutomationRepo) DeleteRule(id int64) error {
	result, err := r.db.Exec(`DELETE FROM automation_rules WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete automation rule: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *AutomationRepo) GetRule(id int64) (*model.AutomationRule, error) {
	row := r.db.QueryRow(automationRuleSelect+` WHERE ar.id=$1`, id)
	rule, err := scanAutomationRule(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, sql.ErrNoRows
	}
	return rule, err
}

func (r *AutomationRepo) ListRules(userID int64, isAdmin bool, page, size int) ([]model.AutomationRule, int64, error) {
	where := "WHERE ar.owner_id=$1"
	args := []any{userID}
	if isAdmin {
		where = "WHERE 1=1"
		args = nil
	}
	var total int64
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM automation_rules ar `+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count automation rules: %w", err)
	}
	args = append(args, size, (page-1)*size)
	rows, err := r.db.Query(automationRuleSelect+` `+where+fmt.Sprintf(` ORDER BY ar.updated_at DESC, ar.id DESC LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list automation rules: %w", err)
	}
	defer rows.Close()
	items := make([]model.AutomationRule, 0)
	for rows.Next() {
		item, err := scanAutomationRule(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, *item)
	}
	return items, total, rows.Err()
}

func (r *AutomationRepo) ListEnabledRules(triggerType string, sheetID *int64) ([]model.AutomationRule, error) {
	query := automationRuleSelect + ` WHERE ar.enabled=TRUE AND ar.trigger_type=$1`
	args := []any{triggerType}
	if sheetID != nil {
		query += ` AND ar.sheet_id=$2`
		args = append(args, *sheetID)
	}
	query += ` ORDER BY ar.id`
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list enabled automation rules: %w", err)
	}
	defer rows.Close()
	items := make([]model.AutomationRule, 0)
	for rows.Next() {
		item, err := scanAutomationRule(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (r *AutomationRepo) UpdateRuleRunResult(id int64, status, message string) error {
	_, err := r.db.Exec(
		`UPDATE automation_rules SET last_triggered_at=NOW(), last_status=$2, last_message=$3, updated_at=NOW() WHERE id=$1`,
		id, status, message,
	)
	return err
}

func (r *AutomationRepo) UpdateTriggerState(ruleID, sheetID int64, rowIndex int, matched bool, fingerprint string, allowTrigger bool) (bool, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT INTO automation_trigger_states
		 (rule_id,sheet_id,row_index,last_match,last_fingerprint,updated_at)
		 VALUES($1,$2,$3,FALSE,'',NOW())
		 ON CONFLICT(rule_id,sheet_id,row_index) DO NOTHING`,
		ruleID, sheetID, rowIndex,
	); err != nil {
		return false, err
	}

	var previousMatch bool
	var previousFingerprint string
	err = tx.QueryRow(
		`SELECT last_match,last_fingerprint FROM automation_trigger_states
		 WHERE rule_id=$1 AND sheet_id=$2 AND row_index=$3 FOR UPDATE`, ruleID, sheetID, rowIndex,
	).Scan(&previousMatch, &previousFingerprint)
	if err != nil {
		return false, err
	}
	shouldTrigger := allowTrigger && matched && (!previousMatch || previousFingerprint != fingerprint)
	if _, err := tx.Exec(
		`UPDATE automation_trigger_states SET
		 last_match=$4,last_fingerprint=$5,
		 last_triggered_at=CASE WHEN $6 THEN NOW() ELSE last_triggered_at END,
		 updated_at=NOW()
		 WHERE rule_id=$1 AND sheet_id=$2 AND row_index=$3`,
		ruleID, sheetID, rowIndex, matched, fingerprint, shouldTrigger,
	); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return shouldTrigger, nil
}

type automationRuleJSONValues struct {
	watchedColumns []byte
	conditions     []byte
	approvalSteps  []byte
	approvalRanges []byte
	actions        []byte
}

func automationRuleValues(rule *model.AutomationRule) (*automationRuleJSONValues, error) {
	values := &automationRuleJSONValues{}
	var err error
	if values.watchedColumns, err = json.Marshal(rule.WatchedColumns); err != nil {
		return nil, err
	}
	if values.conditions, err = json.Marshal(rule.Conditions); err != nil {
		return nil, err
	}
	if values.approvalSteps, err = json.Marshal(rule.ApprovalSteps); err != nil {
		return nil, err
	}
	if values.approvalRanges, err = json.Marshal(rule.ApprovalRanges); err != nil {
		return nil, err
	}
	if values.actions, err = json.Marshal(rule.Actions); err != nil {
		return nil, err
	}
	return values, nil
}

const automationRuleSelect = `SELECT
	 ar.id, ar.name, ar.description, ar.owner_id, COALESCE(u.username,''), ar.sheet_id,
	 COALESCE(s.name,''), w.id, COALESCE(w.name,''), ar.trigger_type, ar.watched_columns,
	 ar.cron_expr, ar.timezone, ar.condition_logic, ar.conditions, ar.approval_steps,
	 ar.approval_ranges, ar.actions, ar.hold_changes, ar.enabled,
	 ar.last_triggered_at, ar.last_status, ar.last_message,
	 ar.created_at, ar.updated_at
	 FROM automation_rules ar
	 JOIN users u ON u.id=ar.owner_id
	 LEFT JOIN sheets s ON s.id=ar.sheet_id
	 LEFT JOIN workbooks w ON w.id=s.workbook_id`

type automationRuleScanner interface {
	Scan(dest ...any) error
}

func scanAutomationRule(scanner automationRuleScanner) (*model.AutomationRule, error) {
	var item model.AutomationRule
	var watchedColumns, conditions, approvalSteps, approvalRanges, actions []byte
	err := scanner.Scan(
		&item.ID, &item.Name, &item.Description, &item.OwnerID, &item.OwnerName, &item.SheetID,
		&item.SheetName, &item.WorkbookID, &item.WorkbookName, &item.TriggerType, &watchedColumns,
		&item.CronExpr, &item.Timezone, &item.ConditionLogic, &conditions, &approvalSteps,
		&approvalRanges, &actions, &item.HoldChanges, &item.Enabled,
		&item.LastTriggeredAt, &item.LastStatus, &item.LastMessage,
		&item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(watchedColumns, &item.WatchedColumns); err != nil {
		return nil, fmt.Errorf("decode watched columns: %w", err)
	}
	if err := json.Unmarshal(conditions, &item.Conditions); err != nil {
		return nil, fmt.Errorf("decode automation conditions: %w", err)
	}
	if err := json.Unmarshal(approvalSteps, &item.ApprovalSteps); err != nil {
		return nil, fmt.Errorf("decode approval steps: %w", err)
	}
	if err := json.Unmarshal(approvalRanges, &item.ApprovalRanges); err != nil {
		return nil, fmt.Errorf("decode approval ranges: %w", err)
	}
	if err := json.Unmarshal(actions, &item.Actions); err != nil {
		return nil, fmt.Errorf("decode automation actions: %w", err)
	}
	return &item, nil
}

func (r *AutomationRepo) GetRowData(sheetID int64, rowIndex int) (map[string]any, error) {
	var raw []byte
	err := r.db.QueryRow(`SELECT data FROM rows WHERE sheet_id=$1 AND row_index=$2`, sheetID, rowIndex).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get automation row data: %w", err)
	}
	result := make(map[string]any)
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *AutomationRepo) ListRowData(sheetID int64, limit int) ([]model.SheetVersionRowSnapshot, error) {
	rows, err := r.db.Query(`SELECT row_index, data FROM rows WHERE sheet_id=$1 ORDER BY row_index LIMIT $2`, sheetID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]model.SheetVersionRowSnapshot, 0)
	for rows.Next() {
		var item model.SheetVersionRowSnapshot
		if err := rows.Scan(&item.RowIndex, &item.Data); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *AutomationRepo) ResolveDepartmentUsers(departmentIDs []int64) (map[int64][]int64, error) {
	result := make(map[int64][]int64)
	if len(departmentIDs) == 0 {
		return result, nil
	}
	rows, err := r.db.Query(
		`SELECT dm.department_id, dm.user_id FROM department_members dm
		 JOIN users u ON u.id=dm.user_id AND u.status=1
		 WHERE dm.department_id=ANY($1) ORDER BY dm.department_id,dm.user_id`, pq.Array(departmentIDs),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var departmentID, userID int64
		if err := rows.Scan(&departmentID, &userID); err != nil {
			return nil, err
		}
		result[departmentID] = append(result[departmentID], userID)
	}
	return result, rows.Err()
}

func (r *AutomationRepo) CreateRun(
	rule *model.AutomationRule,
	snapshot model.AutomationRuleSnapshot,
	context model.AutomationTriggerContext,
	triggeredBy *int64,
	idempotencyKey string,
	approvalSeeds []model.ApprovalRequestSeed,
) (*model.AutomationRun, bool, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()

	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		return nil, false, err
	}
	contextJSON, err := json.Marshal(context)
	if err != nil {
		return nil, false, err
	}
	status := "running"
	if len(approvalSeeds) > 0 {
		status = "waiting_approval"
	}
	var key any
	if strings.TrimSpace(idempotencyKey) != "" {
		key = idempotencyKey
	}
	run := &model.AutomationRun{}
	err = tx.QueryRow(
		`INSERT INTO automation_runs
		 (rule_id,rule_name,rule_snapshot,trigger_type,status,triggered_by,sheet_id,row_index,
		  idempotency_key,trigger_context,current_step,result,started_at,created_at,updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,'{}',NOW(),NOW(),NOW())
		 ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
		 RETURNING id,started_at,created_at,updated_at`,
		rule.ID, rule.Name, snapshotJSON, rule.TriggerType, status, triggeredBy, context.SheetID,
		context.RowIndex, key, contextJSON,
	).Scan(&run.ID, &run.StartedAt, &run.CreatedAt, &run.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) && key != nil {
		if err := tx.QueryRow(`SELECT id FROM automation_runs WHERE idempotency_key=$1`, key).Scan(&run.ID); err != nil {
			return nil, false, err
		}
		return run, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("create automation run: %w", err)
	}

	run.RuleID = &rule.ID
	run.RuleName = rule.Name
	run.RuleSnapshot = snapshot
	run.TriggerType = rule.TriggerType
	run.Status = status
	run.TriggeredBy = triggeredBy
	run.SheetID = context.SheetID
	run.RowIndex = context.RowIndex
	run.TriggerContext = context

	for index, seed := range approvalSeeds {
		requestStatus := "queued"
		var activatedAt any
		if index == 0 {
			requestStatus = "pending"
			activatedAt = time.Now()
		}
		var requestID int64
		if err := tx.QueryRow(
			`INSERT INTO approval_requests
			 (run_id,step_index,name,status,required_approvals,activated_at,created_at,updated_at)
			 VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW()) RETURNING id`,
			run.ID, seed.StepIndex, seed.Name, requestStatus, seed.RequiredApprovals, activatedAt,
		).Scan(&requestID); err != nil {
			return nil, false, err
		}
		for _, assignee := range seed.Assignees {
			if _, err := tx.Exec(
				`INSERT INTO approval_assignees
				 (request_id,user_id,source_type,source_id,status,created_at,updated_at)
				 VALUES ($1,$2,$3,$4,'pending',NOW(),NOW())`,
				requestID, assignee.UserID, assignee.SourceType, assignee.SourceID,
			); err != nil {
				return nil, false, err
			}
		}
	}
	if len(context.PendingChanges) > 0 {
		if triggeredBy == nil || *triggeredBy <= 0 {
			return nil, false, fmt.Errorf("pending cell approval requires a submitter")
		}
		for _, change := range context.PendingChanges {
			if _, err := tx.Exec(
				`INSERT INTO cell_approval_states
				 (run_id,rule_id,sheet_id,row_index,column_key,status,proposed_value,original_value,submitted_by,submitted_at,updated_at)
				 VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,NOW(),NOW())`,
				run.ID, rule.ID, change.SheetID, change.Row, change.Col,
				change.ProposedValue, change.OriginalValue, *triggeredBy,
			); err != nil {
				if pqErr, ok := err.(*pq.Error); ok && pqErr.Constraint == "uq_cell_approval_states_pending_cell" {
					return nil, false, fmt.Errorf("cell %s%d already has a pending approval", change.Col, change.Row+2)
				}
				return nil, false, err
			}
		}
	}
	if err := insertAutomationRunLogTx(tx, run.ID, "info", "run.created", "自动化运行已创建", map[string]any{"status": status}); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return run, true, nil
}

func (r *AutomationRepo) GetRun(id int64) (*model.AutomationRun, error) {
	row := r.db.QueryRow(automationRunSelect+` WHERE run.id=$1`, id)
	return scanAutomationRun(row)
}

func (r *AutomationRepo) ListRuns(userID int64, isAdmin bool, status string, page, size int) ([]model.AutomationRun, int64, error) {
	where := []string{"1=1"}
	args := make([]any, 0)
	add := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if !isAdmin {
		placeholder := add(userID)
		where = append(where, `(COALESCE(ar.owner_id,(run.rule_snapshot->>'owner_id')::BIGINT)=`+placeholder+` OR run.triggered_by=`+placeholder+` OR EXISTS (
		 SELECT 1 FROM approval_requests req JOIN approval_assignees aa ON aa.request_id=req.id
		 WHERE req.run_id=run.id AND aa.user_id=`+placeholder+`))`)
	}
	if status != "" {
		where = append(where, "run.status="+add(status))
	}
	whereSQL := strings.Join(where, " AND ")
	var total int64
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM automation_runs run LEFT JOIN automation_rules ar ON ar.id=run.rule_id WHERE `+whereSQL, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	limit := add(size)
	offset := add((page - 1) * size)
	rows, err := r.db.Query(automationRunSelect+` WHERE `+whereSQL+` ORDER BY run.created_at DESC,run.id DESC LIMIT `+limit+` OFFSET `+offset, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := make([]model.AutomationRun, 0)
	for rows.Next() {
		item, err := scanAutomationRun(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, *item)
	}
	return items, total, rows.Err()
}

const automationRunSelect = `SELECT
	 run.id,run.rule_id,run.rule_name,run.rule_snapshot,run.trigger_type,run.status,
	 run.triggered_by,COALESCE(actor.username,''),run.sheet_id,COALESCE(s.name,''),
	 COALESCE(w.name,''),run.row_index,run.trigger_context,run.current_step,run.result,
	 run.error_message,run.started_at,run.finished_at,run.created_at,run.updated_at
	 FROM automation_runs run
	 LEFT JOIN automation_rules ar ON ar.id=run.rule_id
	 LEFT JOIN users actor ON actor.id=run.triggered_by
	 LEFT JOIN sheets s ON s.id=run.sheet_id
	 LEFT JOIN workbooks w ON w.id=s.workbook_id`

func scanAutomationRun(scanner automationRuleScanner) (*model.AutomationRun, error) {
	var run model.AutomationRun
	var snapshot, context []byte
	err := scanner.Scan(
		&run.ID, &run.RuleID, &run.RuleName, &snapshot, &run.TriggerType, &run.Status,
		&run.TriggeredBy, &run.TriggeredByName, &run.SheetID, &run.SheetName,
		&run.WorkbookName, &run.RowIndex, &context, &run.CurrentStep, &run.Result,
		&run.ErrorMessage, &run.StartedAt, &run.FinishedAt, &run.CreatedAt, &run.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(snapshot, &run.RuleSnapshot); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(context, &run.TriggerContext); err != nil {
		return nil, err
	}
	return &run, nil
}

func (r *AutomationRepo) FinishRun(runID int64, status string, result any, errorMessage string) error {
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return err
	}
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`UPDATE automation_runs SET status=$2,result=$3,error_message=$4,finished_at=NOW(),updated_at=NOW() WHERE id=$1`,
		runID, status, resultJSON, errorMessage,
	); err != nil {
		return err
	}
	level := "info"
	if status == "failed" {
		level = "error"
	}
	if err := insertAutomationRunLogTx(tx, runID, level, "run."+status, errorMessage, result); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *AutomationRepo) AddRunLog(runID int64, level, event, message string, details any) error {
	detailsJSON, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(
		`INSERT INTO automation_run_logs(run_id,level,event,message,details,created_at) VALUES($1,$2,$3,$4,$5,NOW())`,
		runID, level, event, message, detailsJSON,
	)
	return err
}

func insertAutomationRunLogTx(tx *sql.Tx, runID int64, level, event, message string, details any) error {
	detailsJSON, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = tx.Exec(
		`INSERT INTO automation_run_logs(run_id,level,event,message,details,created_at) VALUES($1,$2,$3,$4,$5,NOW())`,
		runID, level, event, message, detailsJSON,
	)
	return err
}

func (r *AutomationRepo) ListRunLogs(runID int64) ([]model.AutomationRunLog, error) {
	rows, err := r.db.Query(
		`SELECT id,run_id,level,event,message,details,created_at FROM automation_run_logs WHERE run_id=$1 ORDER BY created_at,id`, runID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]model.AutomationRunLog, 0)
	for rows.Next() {
		var item model.AutomationRunLog
		if err := rows.Scan(&item.ID, &item.RunID, &item.Level, &item.Event, &item.Message, &item.Details, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *AutomationRepo) ListRunApprovals(runID int64) ([]model.ApprovalRequest, error) {
	rows, err := r.db.Query(
		`SELECT req.id,req.run_id,run.rule_name,req.step_index,req.name,req.status,
		 req.required_approvals,
		 (SELECT COUNT(*)::INT FROM approval_assignees aa WHERE aa.request_id=req.id AND aa.status='approved'),
		 req.activated_at,req.decided_at,req.created_at,req.updated_at
		 FROM approval_requests req JOIN automation_runs run ON run.id=req.run_id
		 WHERE req.run_id=$1 ORDER BY req.step_index`, runID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]model.ApprovalRequest, 0)
	for rows.Next() {
		var item model.ApprovalRequest
		if err := rows.Scan(
			&item.ID, &item.RunID, &item.RuleName, &item.StepIndex, &item.Name, &item.Status,
			&item.RequiredApprovals, &item.ApprovedCount, &item.ActivatedAt, &item.DecidedAt,
			&item.CreatedAt, &item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		assignees, err := r.listApprovalAssignees(item.ID)
		if err != nil {
			return nil, err
		}
		item.Assignees = assignees
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *AutomationRepo) listApprovalAssignees(requestID int64) ([]model.ApprovalAssignee, error) {
	rows, err := r.db.Query(
		`SELECT aa.user_id,COALESCE(u.username,''),u.avatar,aa.source_type,aa.source_id,
		 aa.status,aa.comment,aa.decided_at
		 FROM approval_assignees aa JOIN users u ON u.id=aa.user_id
		 WHERE aa.request_id=$1 ORDER BY u.username,u.id`, requestID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]model.ApprovalAssignee, 0)
	for rows.Next() {
		var item model.ApprovalAssignee
		if err := rows.Scan(
			&item.UserID, &item.Username, &item.Avatar, &item.SourceType, &item.SourceID,
			&item.Status, &item.Comment, &item.DecidedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *AutomationRepo) ListPendingApprovals(userID int64, page, size int) ([]model.ApprovalRequest, int64, error) {
	var total int64
	if err := r.db.QueryRow(
		`SELECT COUNT(*) FROM approval_requests req
		 JOIN approval_assignees aa ON aa.request_id=req.id
		 JOIN automation_runs run ON run.id=req.run_id
		 WHERE aa.user_id=$1 AND aa.status='pending' AND req.status='pending' AND run.status='waiting_approval'`,
		userID,
	).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := r.db.Query(
		`SELECT req.id,req.run_id,run.rule_name,req.step_index,req.name,req.status,
		 req.required_approvals,
		 (SELECT COUNT(*)::INT FROM approval_assignees votes WHERE votes.request_id=req.id AND votes.status='approved'),
		 req.activated_at,req.decided_at,req.created_at,req.updated_at
		 FROM approval_requests req
		 JOIN approval_assignees aa ON aa.request_id=req.id
		 JOIN automation_runs run ON run.id=req.run_id
		 WHERE aa.user_id=$1 AND aa.status='pending' AND req.status='pending' AND run.status='waiting_approval'
		 ORDER BY req.activated_at DESC,req.id DESC LIMIT $2 OFFSET $3`,
		userID, size, (page-1)*size,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := make([]model.ApprovalRequest, 0)
	for rows.Next() {
		var item model.ApprovalRequest
		if err := rows.Scan(
			&item.ID, &item.RunID, &item.RuleName, &item.StepIndex, &item.Name, &item.Status,
			&item.RequiredApprovals, &item.ApprovedCount, &item.ActivatedAt, &item.DecidedAt,
			&item.CreatedAt, &item.UpdatedAt,
		); err != nil {
			return nil, 0, err
		}
		run, err := r.GetRun(item.RunID)
		if err != nil {
			return nil, 0, err
		}
		item.Run = run
		items = append(items, item)
	}
	return items, total, rows.Err()
}

func (r *AutomationRepo) DecideApproval(requestID, userID int64, decision, comment string) (*model.ApprovalDecisionResult, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var result model.ApprovalDecisionResult
	var runStatus, requestStatus string
	var required int
	err = tx.QueryRow(
		`SELECT req.run_id,run.status,req.status,req.required_approvals,
		 COALESCE(ar.owner_id,(run.rule_snapshot->>'owner_id')::BIGINT),run.triggered_by
		 FROM approval_requests req
		 JOIN automation_runs run ON run.id=req.run_id
		 LEFT JOIN automation_rules ar ON ar.id=run.rule_id
		 WHERE req.id=$1 FOR UPDATE OF req,run`, requestID,
	).Scan(&result.RunID, &runStatus, &requestStatus, &required, &result.OwnerID, &result.TriggeredBy)
	if err != nil {
		return nil, err
	}
	if runStatus != "waiting_approval" || requestStatus != "pending" {
		return nil, fmt.Errorf("approval request is no longer pending")
	}

	var assigneeStatus string
	err = tx.QueryRow(
		`SELECT status FROM approval_assignees WHERE request_id=$1 AND user_id=$2 FOR UPDATE`,
		requestID, userID,
	).Scan(&assigneeStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("approval is not assigned to this user")
	}
	if err != nil {
		return nil, err
	}
	if assigneeStatus != "pending" {
		return nil, fmt.Errorf("approval decision has already been submitted")
	}

	assigneeDecision := "approved"
	if decision == "reject" {
		assigneeDecision = "rejected"
	}
	if _, err := tx.Exec(
		`UPDATE approval_assignees SET status=$3,comment=$4,decided_at=NOW(),updated_at=NOW()
		 WHERE request_id=$1 AND user_id=$2`, requestID, userID, assigneeDecision, strings.TrimSpace(comment),
	); err != nil {
		return nil, err
	}
	result.RequestID = requestID

	if decision == "reject" {
		if _, err := tx.Exec(`UPDATE approval_requests SET status='rejected',decided_at=NOW(),updated_at=NOW() WHERE id=$1`, requestID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`UPDATE approval_requests SET status='cancelled',decided_at=NOW(),updated_at=NOW() WHERE run_id=$1 AND status='queued'`, result.RunID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(
			`UPDATE approval_assignees SET status='cancelled',updated_at=NOW()
			 WHERE request_id IN (SELECT id FROM approval_requests WHERE run_id=$1) AND status='pending'`, result.RunID,
		); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(
			`UPDATE automation_runs SET status='rejected',finished_at=NOW(),updated_at=NOW() WHERE id=$1`, result.RunID,
		); err != nil {
			return nil, err
		}
		if err := insertAutomationRunLogTx(tx, result.RunID, "warning", "approval.rejected", "审批已拒绝", map[string]any{"request_id": requestID, "user_id": userID, "comment": comment}); err != nil {
			return nil, err
		}
		result.RunStatus = "rejected"
		result.RequestStatus = "rejected"
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return &result, nil
	}

	var approvedCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM approval_assignees WHERE request_id=$1 AND status='approved'`, requestID).Scan(&approvedCount); err != nil {
		return nil, err
	}
	if approvedCount < required {
		if err := insertAutomationRunLogTx(tx, result.RunID, "info", "approval.vote", "已提交审批意见", map[string]any{"request_id": requestID, "user_id": userID, "approved_count": approvedCount, "required": required}); err != nil {
			return nil, err
		}
		result.RunStatus = "waiting_approval"
		result.RequestStatus = "pending"
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return &result, nil
	}

	result.StepCompleted = true
	if _, err := tx.Exec(`UPDATE approval_requests SET status='approved',decided_at=NOW(),updated_at=NOW() WHERE id=$1`, requestID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(
		`UPDATE approval_assignees SET status='cancelled',updated_at=NOW() WHERE request_id=$1 AND status='pending'`, requestID,
	); err != nil {
		return nil, err
	}
	var nextRequestID int64
	var nextStep int
	err = tx.QueryRow(
		`SELECT id,step_index FROM approval_requests WHERE run_id=$1 AND status='queued' ORDER BY step_index LIMIT 1 FOR UPDATE`, result.RunID,
	).Scan(&nextRequestID, &nextStep)
	if err == nil {
		if _, err := tx.Exec(`UPDATE approval_requests SET status='pending',activated_at=NOW(),updated_at=NOW() WHERE id=$1`, nextRequestID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(`UPDATE automation_runs SET current_step=$2,updated_at=NOW() WHERE id=$1`, result.RunID, nextStep); err != nil {
			return nil, err
		}
		rows, err := tx.Query(`SELECT user_id FROM approval_assignees WHERE request_id=$1 AND status='pending' ORDER BY user_id`, nextRequestID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var nextUserID int64
			if err := rows.Scan(&nextUserID); err != nil {
				rows.Close()
				return nil, err
			}
			result.NextAssigneeIDs = append(result.NextAssigneeIDs, nextUserID)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		result.NextRequestID = &nextRequestID
		result.RunStatus = "waiting_approval"
		result.RequestStatus = "approved"
	} else if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.Exec(`UPDATE automation_runs SET status='running',updated_at=NOW() WHERE id=$1`, result.RunID); err != nil {
			return nil, err
		}
		result.RunStatus = "running"
		result.RequestStatus = "approved"
	} else {
		return nil, err
	}
	if err := insertAutomationRunLogTx(tx, result.RunID, "info", "approval.step_approved", "审批步骤已通过", map[string]any{"request_id": requestID, "user_id": userID, "approved_count": approvedCount}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &result, nil
}

func (r *AutomationRepo) HasPendingCellApproval(sheetID int64, row int, col string) (bool, error) {
	var exists bool
	err := r.db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM cell_approval_states
		 WHERE sheet_id=$1 AND row_index=$2 AND column_key=$3 AND status='pending')`,
		sheetID, row, strings.TrimSpace(col),
	).Scan(&exists)
	return exists, err
}

func (r *AutomationRepo) UpdateCellApprovalState(runID int64, status string) error {
	_, err := r.db.Exec(
		`UPDATE cell_approval_states SET status=$2,decided_at=NOW(),updated_at=NOW()
		 WHERE run_id=$1 AND status='pending'`,
		runID, status,
	)
	return err
}

func (r *AutomationRepo) ListCellApprovalStates(sheetID int64, limit int) ([]model.CellApprovalState, error) {
	if limit <= 0 || limit > 2000 {
		limit = 1000
	}
	rows, err := r.db.Query(
		`SELECT state.id,state.run_id,state.rule_id,run.rule_name,state.sheet_id,state.row_index,
		 state.column_key,state.status,state.proposed_value,state.original_value,state.submitted_by,
		 COALESCE(u.username,''),state.submitted_at,state.decided_at,state.updated_at,run.trigger_context
		 FROM cell_approval_states state
		 JOIN automation_runs run ON run.id=state.run_id
		 JOIN users u ON u.id=state.submitted_by
		 WHERE state.sheet_id=$1
		   AND (state.status='pending' OR state.updated_at >= NOW() - INTERVAL '30 days')
		 ORDER BY CASE WHEN state.status='pending' THEN 0 ELSE 1 END,state.updated_at DESC,state.id DESC
		 LIMIT $2`,
		sheetID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]model.CellApprovalState, 0)
	for rows.Next() {
		var item model.CellApprovalState
		var contextJSON []byte
		if err := rows.Scan(
			&item.ID, &item.RunID, &item.RuleID, &item.RuleName, &item.SheetID, &item.Row,
			&item.Col, &item.Status, &item.ProposedValue, &item.OriginalValue, &item.SubmittedBy,
			&item.SubmittedByName, &item.SubmittedAt, &item.DecidedAt, &item.UpdatedAt, &contextJSON,
		); err != nil {
			return nil, err
		}
		if err := hydrateCellApprovalContext(&item, contextJSON); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *AutomationRepo) ListRunCellApprovalStates(runID int64) ([]model.CellApprovalState, error) {
	rows, err := r.db.Query(
		`SELECT state.id,state.run_id,state.rule_id,run.rule_name,state.sheet_id,state.row_index,
		 state.column_key,state.status,state.proposed_value,state.original_value,state.submitted_by,
		 COALESCE(u.username,''),state.submitted_at,state.decided_at,state.updated_at,run.trigger_context
		 FROM cell_approval_states state
		 JOIN automation_runs run ON run.id=state.run_id
		 JOIN users u ON u.id=state.submitted_by
		 WHERE state.run_id=$1 ORDER BY state.id`, runID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]model.CellApprovalState, 0)
	for rows.Next() {
		var item model.CellApprovalState
		var contextJSON []byte
		if err := rows.Scan(
			&item.ID, &item.RunID, &item.RuleID, &item.RuleName, &item.SheetID, &item.Row,
			&item.Col, &item.Status, &item.ProposedValue, &item.OriginalValue, &item.SubmittedBy,
			&item.SubmittedByName, &item.SubmittedAt, &item.DecidedAt, &item.UpdatedAt, &contextJSON,
		); err != nil {
			return nil, err
		}
		if err := hydrateCellApprovalContext(&item, contextJSON); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func hydrateCellApprovalContext(item *model.CellApprovalState, contextJSON []byte) error {
	if item == nil || len(contextJSON) == 0 {
		return nil
	}
	var context model.AutomationTriggerContext
	if err := json.Unmarshal(contextJSON, &context); err != nil {
		return err
	}
	item.RelatedData = context.RowData
	item.FieldLabels = context.FieldLabels
	return nil
}

func (r *AutomationRepo) CreateNotifications(userIDs []int64, notification model.UserNotification) ([]int64, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	metadata := notification.Metadata
	if len(metadata) == 0 {
		metadata = json.RawMessage(`{}`)
	}
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	seen := make(map[int64]struct{}, len(userIDs))
	createdFor := make([]int64, 0, len(userIDs))
	for _, userID := range userIDs {
		if userID <= 0 {
			continue
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		if _, err := tx.Exec(
			`INSERT INTO user_notifications
			 (user_id,notification_type,title,content,link_url,entity_type,entity_id,metadata,created_at)
			 VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
			userID, notification.NotificationType, notification.Title, notification.Content,
			notification.LinkURL, notification.EntityType, notification.EntityID, metadata,
		); err != nil {
			return nil, err
		}
		createdFor = append(createdFor, userID)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return createdFor, nil
}

func (r *AutomationRepo) ListNotifications(userID int64, unreadOnly bool, category string, page, size int) ([]model.UserNotification, int64, error) {
	where := `user_id=$1`
	if unreadOnly {
		where += ` AND read_at IS NULL`
	}
	switch category {
	case "erp":
		where += ` AND (notification_type='trade_workflow' OR entity_type='trade_order')`
	case "system":
		where += ` AND NOT (notification_type='trade_workflow' OR entity_type='trade_order')`
	}
	var total int64
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM user_notifications WHERE `+where, userID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := r.db.Query(
		`SELECT id,user_id,notification_type,title,content,link_url,entity_type,entity_id,metadata,read_at,created_at
		 FROM user_notifications WHERE `+where+` ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
		userID, size, (page-1)*size,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := make([]model.UserNotification, 0)
	for rows.Next() {
		var item model.UserNotification
		if err := rows.Scan(
			&item.ID, &item.UserID, &item.NotificationType, &item.Title, &item.Content,
			&item.LinkURL, &item.EntityType, &item.EntityID, &item.Metadata, &item.ReadAt, &item.CreatedAt,
		); err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}

func (r *AutomationRepo) MarkNotificationRead(userID, notificationID int64) error {
	result, err := r.db.Exec(`UPDATE user_notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND user_id=$2`, notificationID, userID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *AutomationRepo) MarkAllNotificationsRead(userID int64, category string) error {
	where := `user_id=$1 AND read_at IS NULL`
	switch category {
	case "erp":
		where += ` AND (notification_type='trade_workflow' OR entity_type='trade_order')`
	case "system":
		where += ` AND NOT (notification_type='trade_workflow' OR entity_type='trade_order')`
	}
	_, err := r.db.Exec(`UPDATE user_notifications SET read_at=NOW() WHERE `+where, userID)
	return err
}

func (r *AutomationRepo) TaskCenterSummary(userID int64) (*model.TaskCenterSummary, error) {
	result := &model.TaskCenterSummary{}
	err := r.db.QueryRow(
		`SELECT
		 (SELECT COUNT(*) FROM approval_requests req
		  JOIN approval_assignees aa ON aa.request_id=req.id
		  JOIN automation_runs run ON run.id=req.run_id
		  WHERE aa.user_id=$1 AND aa.status='pending' AND req.status='pending' AND run.status='waiting_approval'),
		 (SELECT COUNT(*) FROM user_notifications
		  WHERE user_id=$1 AND read_at IS NULL AND (notification_type='trade_workflow' OR entity_type='trade_order')),
		 (SELECT COUNT(*) FROM user_notifications
		  WHERE user_id=$1 AND read_at IS NULL AND NOT (notification_type='trade_workflow' OR entity_type='trade_order')),
		 (SELECT COUNT(*) FROM user_notifications WHERE user_id=$1 AND read_at IS NULL)`, userID,
	).Scan(&result.PendingApprovals, &result.UnreadERPTasks, &result.UnreadSystemNotifications, &result.UnreadNotifications)
	return result, err
}

func (r *AutomationRepo) IsRunAssignee(runID, userID int64) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(
		`SELECT EXISTS(
		 SELECT 1 FROM approval_requests req JOIN approval_assignees aa ON aa.request_id=req.id
		 WHERE req.run_id=$1 AND aa.user_id=$2)`, runID, userID,
	).Scan(&allowed)
	return allowed, err
}
