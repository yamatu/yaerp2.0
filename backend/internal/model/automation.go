package model

import (
	"encoding/json"
	"time"
)

type AutomationCondition struct {
	Column   string `json:"column"`
	Operator string `json:"operator"`
	Value    any    `json:"value,omitempty"`
}

type AutomationApprovalStep struct {
	Name              string  `json:"name"`
	UserIDs           []int64 `json:"user_ids,omitempty"`
	DepartmentIDs     []int64 `json:"department_ids,omitempty"`
	RequiredApprovals int     `json:"required_approvals"`
}

type AutomationApprovalRange struct {
	StartRow *int     `json:"start_row,omitempty"`
	EndRow   *int     `json:"end_row,omitempty"`
	Columns  []string `json:"columns,omitempty"`
}

type AutomationAction struct {
	Type            string  `json:"type"`
	TitleTemplate   string  `json:"title_template,omitempty"`
	MessageTemplate string  `json:"message_template,omitempty"`
	RecipientType   string  `json:"recipient_type,omitempty"`
	UserIDs         []int64 `json:"user_ids,omitempty"`
	DepartmentIDs   []int64 `json:"department_ids,omitempty"`
	ChannelID       *int64  `json:"channel_id,omitempty"`
	SendWhatsApp    bool    `json:"send_whatsapp,omitempty"`
	TargetColumn    string  `json:"target_column,omitempty"`
	Value           any     `json:"value,omitempty"`
	ValueTemplate   string  `json:"value_template,omitempty"`
}

type AutomationRule struct {
	ID              int64                     `json:"id"`
	Name            string                    `json:"name"`
	Description     string                    `json:"description"`
	OwnerID         int64                     `json:"owner_id"`
	OwnerName       string                    `json:"owner_name"`
	SheetID         *int64                    `json:"sheet_id,omitempty"`
	SheetName       string                    `json:"sheet_name,omitempty"`
	WorkbookID      *int64                    `json:"workbook_id,omitempty"`
	WorkbookName    string                    `json:"workbook_name,omitempty"`
	TriggerType     string                    `json:"trigger_type"`
	WatchedColumns  []string                  `json:"watched_columns"`
	CronExpr        string                    `json:"cron_expr"`
	Timezone        string                    `json:"timezone"`
	ConditionLogic  string                    `json:"condition_logic"`
	Conditions      []AutomationCondition     `json:"conditions"`
	ApprovalSteps   []AutomationApprovalStep  `json:"approval_steps"`
	ApprovalRanges  []AutomationApprovalRange `json:"approval_ranges"`
	Actions         []AutomationAction        `json:"actions"`
	HoldChanges     bool                      `json:"hold_changes"`
	Enabled         bool                      `json:"enabled"`
	LastTriggeredAt *time.Time                `json:"last_triggered_at,omitempty"`
	LastStatus      *string                   `json:"last_status,omitempty"`
	LastMessage     string                    `json:"last_message"`
	NextRunAt       *time.Time                `json:"next_run_at,omitempty"`
	CreatedAt       time.Time                 `json:"created_at"`
	UpdatedAt       time.Time                 `json:"updated_at"`
}

type AutomationRuleInput struct {
	Name           string                    `json:"name" binding:"required,max=160"`
	Description    string                    `json:"description"`
	OwnerID        *int64                    `json:"owner_id,omitempty"`
	SheetID        *int64                    `json:"sheet_id,omitempty"`
	TriggerType    string                    `json:"trigger_type" binding:"required,oneof=cell_change schedule manual"`
	WatchedColumns []string                  `json:"watched_columns"`
	CronExpr       string                    `json:"cron_expr"`
	Timezone       string                    `json:"timezone"`
	ConditionLogic string                    `json:"condition_logic"`
	Conditions     []AutomationCondition     `json:"conditions"`
	ApprovalSteps  []AutomationApprovalStep  `json:"approval_steps"`
	ApprovalRanges []AutomationApprovalRange `json:"approval_ranges"`
	Actions        []AutomationAction        `json:"actions"`
	HoldChanges    bool                      `json:"hold_changes"`
	Enabled        *bool                     `json:"enabled,omitempty"`
}

type AutomationRuleSnapshot struct {
	ID             int64                     `json:"id"`
	Name           string                    `json:"name"`
	OwnerID        int64                     `json:"owner_id"`
	SheetID        *int64                    `json:"sheet_id,omitempty"`
	TriggerType    string                    `json:"trigger_type"`
	WatchedColumns []string                  `json:"watched_columns"`
	ConditionLogic string                    `json:"condition_logic"`
	Conditions     []AutomationCondition     `json:"conditions"`
	ApprovalSteps  []AutomationApprovalStep  `json:"approval_steps"`
	ApprovalRanges []AutomationApprovalRange `json:"approval_ranges"`
	Actions        []AutomationAction        `json:"actions"`
	HoldChanges    bool                      `json:"hold_changes"`
}

type PendingCellChange struct {
	SheetID       int64           `json:"sheet_id"`
	Row           int             `json:"row"`
	Col           string          `json:"col"`
	ProposedValue json.RawMessage `json:"proposed_value"`
	OriginalValue json.RawMessage `json:"original_value"`
}

type AutomationTriggerContext struct {
	SheetID        *int64              `json:"sheet_id,omitempty"`
	RowIndex       *int                `json:"row_index,omitempty"`
	RowData        map[string]any      `json:"row_data,omitempty"`
	ChangedValues  map[string]any      `json:"changed_values,omitempty"`
	ChangedCols    []string            `json:"changed_columns,omitempty"`
	FieldLabels    map[string]string   `json:"field_labels,omitempty"`
	PendingChanges []PendingCellChange `json:"pending_changes,omitempty"`
	TriggeredAt    time.Time           `json:"triggered_at"`
	Metadata       map[string]any      `json:"metadata,omitempty"`
}

type CellApprovalState struct {
	ID              int64             `json:"id"`
	RunID           int64             `json:"run_id"`
	RuleID          *int64            `json:"rule_id,omitempty"`
	RuleName        string            `json:"rule_name"`
	SheetID         int64             `json:"sheet_id"`
	Row             int               `json:"row"`
	Col             string            `json:"col"`
	Status          string            `json:"status"`
	ProposedValue   json.RawMessage   `json:"proposed_value,omitempty"`
	OriginalValue   json.RawMessage   `json:"original_value,omitempty"`
	SubmittedBy     int64             `json:"submitted_by"`
	SubmittedByName string            `json:"submitted_by_name"`
	RelatedData     map[string]any    `json:"related_data,omitempty"`
	FieldLabels     map[string]string `json:"field_labels,omitempty"`
	SubmittedAt     time.Time         `json:"submitted_at"`
	DecidedAt       *time.Time        `json:"decided_at,omitempty"`
	UpdatedAt       time.Time         `json:"updated_at"`
}

type CellUpdateResult struct {
	AppliedChanges  []CellUpdate        `json:"applied_changes"`
	PendingStates   []CellApprovalState `json:"pending_states"`
	RevertedChanges []CellUpdate        `json:"reverted_changes"`
}

type AutomationRun struct {
	ID              int64                    `json:"id"`
	RuleID          *int64                   `json:"rule_id,omitempty"`
	RuleName        string                   `json:"rule_name"`
	RuleSnapshot    AutomationRuleSnapshot   `json:"rule_snapshot"`
	TriggerType     string                   `json:"trigger_type"`
	Status          string                   `json:"status"`
	TriggeredBy     *int64                   `json:"triggered_by,omitempty"`
	TriggeredByName string                   `json:"triggered_by_name,omitempty"`
	SheetID         *int64                   `json:"sheet_id,omitempty"`
	SheetName       string                   `json:"sheet_name,omitempty"`
	WorkbookName    string                   `json:"workbook_name,omitempty"`
	RowIndex        *int                     `json:"row_index,omitempty"`
	IdempotencyKey  string                   `json:"-"`
	TriggerContext  AutomationTriggerContext `json:"trigger_context"`
	CurrentStep     int                      `json:"current_step"`
	Result          json.RawMessage          `json:"result,omitempty"`
	ErrorMessage    string                   `json:"error_message"`
	StartedAt       time.Time                `json:"started_at"`
	FinishedAt      *time.Time               `json:"finished_at,omitempty"`
	CreatedAt       time.Time                `json:"created_at"`
	UpdatedAt       time.Time                `json:"updated_at"`
}

type ApprovalAssignee struct {
	UserID     int64      `json:"user_id"`
	Username   string     `json:"username"`
	Avatar     *string    `json:"avatar,omitempty"`
	SourceType string     `json:"source_type"`
	SourceID   *int64     `json:"source_id,omitempty"`
	Status     string     `json:"status"`
	Comment    string     `json:"comment"`
	DecidedAt  *time.Time `json:"decided_at,omitempty"`
}

type ApprovalRequest struct {
	ID                int64              `json:"id"`
	RunID             int64              `json:"run_id"`
	RuleName          string             `json:"rule_name"`
	StepIndex         int                `json:"step_index"`
	Name              string             `json:"name"`
	Status            string             `json:"status"`
	RequiredApprovals int                `json:"required_approvals"`
	ApprovedCount     int                `json:"approved_count"`
	Assignees         []ApprovalAssignee `json:"assignees"`
	Run               *AutomationRun     `json:"run,omitempty"`
	ActivatedAt       *time.Time         `json:"activated_at,omitempty"`
	DecidedAt         *time.Time         `json:"decided_at,omitempty"`
	CreatedAt         time.Time          `json:"created_at"`
	UpdatedAt         time.Time          `json:"updated_at"`
}

type ApprovalAssigneeSeed struct {
	UserID     int64
	SourceType string
	SourceID   *int64
}

type ApprovalRequestSeed struct {
	StepIndex         int
	Name              string
	RequiredApprovals int
	Assignees         []ApprovalAssigneeSeed
}

type ApprovalDecisionInput struct {
	Decision string `json:"decision" binding:"required,oneof=approve reject"`
	Comment  string `json:"comment" binding:"omitempty,max=1000"`
}

type ManualAutomationTriggerInput struct {
	RowIndex *int           `json:"row_index,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

type AutomationRunDetail struct {
	Run       *AutomationRun     `json:"run"`
	Approvals []ApprovalRequest  `json:"approvals"`
	Logs      []AutomationRunLog `json:"logs"`
}

type ApprovalDecisionResult struct {
	RunID           int64
	RunStatus       string
	RequestID       int64
	RequestStatus   string
	StepCompleted   bool
	NextRequestID   *int64
	NextAssigneeIDs []int64
	OwnerID         int64
	TriggeredBy     *int64
}

type AutomationRunLog struct {
	ID        int64           `json:"id"`
	RunID     int64           `json:"run_id"`
	Level     string          `json:"level"`
	Event     string          `json:"event"`
	Message   string          `json:"message"`
	Details   json.RawMessage `json:"details,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
}

type UserNotification struct {
	ID               int64           `json:"id"`
	UserID           int64           `json:"user_id"`
	NotificationType string          `json:"notification_type"`
	Title            string          `json:"title"`
	Content          string          `json:"content"`
	LinkURL          string          `json:"link_url"`
	EntityType       string          `json:"entity_type"`
	EntityID         *int64          `json:"entity_id,omitempty"`
	Metadata         json.RawMessage `json:"metadata,omitempty"`
	ReadAt           *time.Time      `json:"read_at,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
}

type TaskCenterSummary struct {
	PendingApprovals          int64 `json:"pending_approvals"`
	UnreadERPTasks            int64 `json:"unread_erp_tasks"`
	UnreadSystemNotifications int64 `json:"unread_system_notifications"`
	UnreadNotifications       int64 `json:"unread_notifications"`
}
