package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/robfig/cron/v3"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

var (
	ErrAutomationAccessDenied = errors.New("automation access denied")
	ErrAutomationInvalid      = errors.New("invalid automation rule")
)

const maxAutomationScheduleRows = 10000

var (
	automationCronParser = cron.NewParser(
		cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor,
	)
	templateVariablePattern = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)
)

type AutomationService struct {
	repo              *repo.AutomationRepo
	sheetRepo         *repo.SheetRepo
	sheetService      *SheetService
	permService       *PermissionService
	channelService    *ChannelService
	cron              *cron.Cron
	mu                sync.RWMutex
	entryIDs          map[int64]cron.EntryID
	notificationHook  func([]int64)
	cellBroadcastHook func(int64, []model.CellUpdate)
	approvalStateHook func([]int64)
}

func NewAutomationService(
	automationRepo *repo.AutomationRepo,
	sheetRepo *repo.SheetRepo,
	sheetService *SheetService,
	permService *PermissionService,
	channelService *ChannelService,
) *AutomationService {
	return &AutomationService{
		repo: automationRepo, sheetRepo: sheetRepo, sheetService: sheetService,
		permService: permService, channelService: channelService,
		cron: cron.New(
			cron.WithParser(automationCronParser),
			cron.WithChain(cron.Recover(cron.DefaultLogger), cron.SkipIfStillRunning(cron.DefaultLogger)),
		),
		entryIDs: make(map[int64]cron.EntryID),
	}
}

func (s *AutomationService) SetNotificationHook(hook func([]int64)) {
	s.notificationHook = hook
}

func (s *AutomationService) SetCellBroadcastHook(hook func(int64, []model.CellUpdate)) {
	s.cellBroadcastHook = hook
}

func (s *AutomationService) SetApprovalStateHook(hook func([]int64)) {
	s.approvalStateHook = hook
}

func (s *AutomationService) Start() error {
	rules, err := s.repo.ListEnabledRules("schedule", nil)
	if err != nil {
		return err
	}
	for index := range rules {
		if err := s.registerSchedule(&rules[index]); err != nil {
			return fmt.Errorf("register automation rule %d: %w", rules[index].ID, err)
		}
	}
	s.cron.Start()
	return nil
}

func (s *AutomationService) Stop() {
	<-s.cron.Stop().Done()
}

func (s *AutomationService) CreateRule(userID int64, input *model.AutomationRuleInput) (*model.AutomationRule, error) {
	rule, err := s.ruleFromInput(userID, nil, input)
	if err != nil {
		return nil, err
	}
	if err := s.repo.CreateRule(rule); err != nil {
		return nil, err
	}
	if err := s.reloadSchedule(rule); err != nil {
		return nil, err
	}
	created, err := s.repo.GetRule(rule.ID)
	if err == nil {
		s.attachNextRun(created)
		s.recordAutomationOperation(userID, "automation.rule.create", "创建自动化规则", created, nil, created)
	}
	return created, err
}

func (s *AutomationService) UpdateRule(userID, ruleID int64, input *model.AutomationRuleInput) (*model.AutomationRule, error) {
	existing, err := s.repo.GetRule(ruleID)
	if err != nil {
		return nil, err
	}
	if err := s.ensureRuleManage(userID, existing); err != nil {
		return nil, err
	}
	rule, err := s.ruleFromInput(userID, existing, input)
	if err != nil {
		return nil, err
	}
	if err := s.repo.UpdateRule(rule); err != nil {
		return nil, err
	}
	if err := s.reloadSchedule(rule); err != nil {
		return nil, err
	}
	updated, err := s.repo.GetRule(rule.ID)
	if err == nil {
		s.attachNextRun(updated)
		s.recordAutomationOperation(userID, "automation.rule.update", "更新自动化规则", updated, existing, updated)
	}
	return updated, err
}

func (s *AutomationService) DeleteRule(userID, ruleID int64) error {
	rule, err := s.repo.GetRule(ruleID)
	if err != nil {
		return err
	}
	if err := s.ensureRuleManage(userID, rule); err != nil {
		return err
	}
	if err := s.repo.DeleteRule(rule.ID); err != nil {
		return err
	}
	s.removeSchedule(rule.ID)
	s.recordAutomationOperation(userID, "automation.rule.delete", "删除自动化规则", rule, rule, nil)
	return nil
}

func (s *AutomationService) GetRule(userID, ruleID int64) (*model.AutomationRule, error) {
	rule, err := s.repo.GetRule(ruleID)
	if err != nil {
		return nil, err
	}
	if err := s.ensureRuleManage(userID, rule); err != nil {
		return nil, err
	}
	s.attachNextRun(rule)
	return rule, nil
}

func (s *AutomationService) ListRules(userID int64, page, size int) ([]model.AutomationRule, int64, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, 0, err
	}
	page, size = normalizeAutomationPage(page, size, 100)
	rules, total, err := s.repo.ListRules(userID, isAdmin, page, size)
	if err != nil {
		return nil, 0, err
	}
	for index := range rules {
		s.attachNextRun(&rules[index])
	}
	return rules, total, nil
}

func (s *AutomationService) ruleFromInput(userID int64, existing *model.AutomationRule, input *model.AutomationRuleInput) (*model.AutomationRule, error) {
	if input == nil {
		return nil, ErrAutomationInvalid
	}
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	ownerID := userID
	if existing != nil {
		ownerID = existing.OwnerID
	}
	if input.OwnerID != nil && *input.OwnerID > 0 {
		if !isAdmin && *input.OwnerID != userID {
			return nil, ErrAutomationAccessDenied
		}
		ownerID = *input.OwnerID
	}
	if err := s.permService.ValidateEditableUsers([]int64{ownerID}); err != nil {
		return nil, fmt.Errorf("%w: 规则负责人无效", ErrAutomationInvalid)
	}
	enabled := true
	if existing != nil {
		enabled = existing.Enabled
	}
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	rule := &model.AutomationRule{
		Name: strings.TrimSpace(input.Name), Description: strings.TrimSpace(input.Description),
		OwnerID: ownerID, SheetID: input.SheetID, TriggerType: strings.TrimSpace(input.TriggerType),
		WatchedColumns: normalizeAutomationColumns(input.WatchedColumns), CronExpr: strings.TrimSpace(input.CronExpr),
		Timezone: strings.TrimSpace(input.Timezone), ConditionLogic: strings.ToLower(strings.TrimSpace(input.ConditionLogic)),
		Conditions:     append([]model.AutomationCondition(nil), input.Conditions...),
		ApprovalSteps:  append([]model.AutomationApprovalStep(nil), input.ApprovalSteps...),
		ApprovalRanges: append([]model.AutomationApprovalRange(nil), input.ApprovalRanges...),
		Actions:        append([]model.AutomationAction(nil), input.Actions...),
		HoldChanges:    input.HoldChanges, Enabled: enabled,
	}
	if existing != nil {
		rule.ID = existing.ID
	}
	if err := s.validateRule(rule); err != nil {
		return nil, err
	}
	return rule, nil
}

func (s *AutomationService) validateRule(rule *model.AutomationRule) error {
	if rule == nil || rule.OwnerID <= 0 || rule.Name == "" || utf8.RuneCountInString(rule.Name) > 160 {
		return fmt.Errorf("%w: 规则名称或负责人无效", ErrAutomationInvalid)
	}
	if rule.ConditionLogic == "" {
		rule.ConditionLogic = "all"
	}
	if rule.ConditionLogic != "all" && rule.ConditionLogic != "any" {
		return fmt.Errorf("%w: 条件逻辑仅支持 all/any", ErrAutomationInvalid)
	}
	if rule.TriggerType != "cell_change" && rule.TriggerType != "schedule" && rule.TriggerType != "manual" {
		return fmt.Errorf("%w: 触发类型仅支持 cell_change/schedule/manual", ErrAutomationInvalid)
	}
	if rule.Timezone == "" {
		rule.Timezone = "Asia/Shanghai"
	}
	if _, err := time.LoadLocation(rule.Timezone); err != nil {
		return fmt.Errorf("%w: 无效时区", ErrAutomationInvalid)
	}
	if rule.TriggerType == "cell_change" && rule.SheetID == nil {
		return fmt.Errorf("%w: 单元格触发规则必须选择工作表", ErrAutomationInvalid)
	}
	if rule.HoldChanges {
		if rule.TriggerType != "cell_change" || rule.SheetID == nil {
			return fmt.Errorf("%w: 暂存审批仅支持指定工作表的单元格触发规则", ErrAutomationInvalid)
		}
		if len(rule.ApprovalSteps) == 0 {
			return fmt.Errorf("%w: 暂存审批必须至少配置一个审批步骤", ErrAutomationInvalid)
		}
	}
	if rule.TriggerType == "schedule" {
		if rule.CronExpr == "" {
			return fmt.Errorf("%w: 定时规则必须设置 Cron 表达式", ErrAutomationInvalid)
		}
		if _, err := automationCronParser.Parse(rule.CronExpr); err != nil {
			return fmt.Errorf("%w: Cron 表达式无效: %v", ErrAutomationInvalid, err)
		}
	}
	if (len(rule.Conditions) > 0 || hasUpdateCellAction(rule.Actions)) && rule.SheetID == nil {
		return fmt.Errorf("%w: 使用行条件或回写动作时必须选择工作表", ErrAutomationInvalid)
	}
	var columnSet map[string]struct{}
	if rule.SheetID != nil {
		sheet, err := s.sheetRepo.GetSheet(*rule.SheetID)
		if err != nil {
			return err
		}
		workbook, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
		if err != nil {
			return err
		}
		canManage, err := s.permService.CanManageWorkbook(workbook, rule.OwnerID)
		if err != nil {
			return err
		}
		if !canManage {
			return fmt.Errorf("%w: 规则负责人无权管理所选工作表", ErrAutomationAccessDenied)
		}
		columnKeys, err := parseColumnKeys(sheet.Columns)
		if err != nil {
			return fmt.Errorf("%w: 无法读取工作表列定义", ErrAutomationInvalid)
		}
		columnSet = make(map[string]struct{}, len(columnKeys))
		for _, columnKey := range columnKeys {
			columnSet[columnKey] = struct{}{}
		}
		for _, column := range rule.WatchedColumns {
			if _, exists := columnSet[column]; !exists {
				return fmt.Errorf("%w: 监听列 %q 不存在", ErrAutomationInvalid, column)
			}
		}
		if err := validateAutomationApprovalRanges(rule.ApprovalRanges, columnSet); err != nil {
			return err
		}
	}
	for index := range rule.Conditions {
		condition := &rule.Conditions[index]
		condition.Column = strings.TrimSpace(condition.Column)
		condition.Operator = strings.ToLower(strings.TrimSpace(condition.Operator))
		if condition.Column == "" || !validAutomationOperator(condition.Operator) {
			return fmt.Errorf("%w: 第 %d 个条件无效", ErrAutomationInvalid, index+1)
		}
		if columnSet != nil {
			if _, exists := columnSet[condition.Column]; !exists {
				return fmt.Errorf("%w: 条件列 %q 不存在", ErrAutomationInvalid, condition.Column)
			}
		}
		if condition.Operator == "regex" {
			if _, err := regexp.Compile(fmt.Sprint(condition.Value)); err != nil {
				return fmt.Errorf("%w: 第 %d 个正则表达式无效", ErrAutomationInvalid, index+1)
			}
		}
	}
	if len(rule.Actions) == 0 && !rule.HoldChanges {
		return fmt.Errorf("%w: 至少添加一个执行动作", ErrAutomationInvalid)
	}
	if err := s.validateApprovalSteps(rule.ApprovalSteps); err != nil {
		return err
	}
	return s.validateActions(rule, columnSet)
}

func (s *AutomationService) validateApprovalSteps(steps []model.AutomationApprovalStep) error {
	for index := range steps {
		step := &steps[index]
		step.Name = strings.TrimSpace(step.Name)
		step.UserIDs = normalizeAutomationIDs(step.UserIDs)
		step.DepartmentIDs = normalizeAutomationIDs(step.DepartmentIDs)
		if step.Name == "" {
			step.Name = fmt.Sprintf("审批步骤 %d", index+1)
		}
		if err := s.permService.ValidateEditableUsers(step.UserIDs); err != nil {
			return fmt.Errorf("%w: %v", ErrAutomationInvalid, err)
		}
		if err := s.permService.ValidateDepartments(step.DepartmentIDs); err != nil {
			return fmt.Errorf("%w: %v", ErrAutomationInvalid, err)
		}
		seeds, err := s.resolveApprovalAssignees(*step)
		if err != nil {
			return err
		}
		if len(seeds) == 0 {
			return fmt.Errorf("%w: 审批步骤 %d 没有有效审批人", ErrAutomationInvalid, index+1)
		}
		if step.RequiredApprovals <= 0 {
			step.RequiredApprovals = 1
		}
		if step.RequiredApprovals > len(seeds) {
			return fmt.Errorf("%w: 审批步骤 %d 所需人数超过审批人数", ErrAutomationInvalid, index+1)
		}
	}
	return nil
}

func (s *AutomationService) validateActions(rule *model.AutomationRule, columnSet map[string]struct{}) error {
	for index := range rule.Actions {
		action := &rule.Actions[index]
		action.Type = strings.ToLower(strings.TrimSpace(action.Type))
		action.RecipientType = strings.ToLower(strings.TrimSpace(action.RecipientType))
		action.UserIDs = normalizeAutomationIDs(action.UserIDs)
		action.DepartmentIDs = normalizeAutomationIDs(action.DepartmentIDs)
		switch action.Type {
		case "notify":
			if action.RecipientType == "" {
				action.RecipientType = "owner"
			}
			if action.RecipientType != "owner" && action.RecipientType != "trigger_user" && action.RecipientType != "users_departments" {
				return fmt.Errorf("%w: 第 %d 个通知收件人类型无效", ErrAutomationInvalid, index+1)
			}
			if action.RecipientType == "users_departments" && len(action.UserIDs)+len(action.DepartmentIDs) == 0 {
				return fmt.Errorf("%w: 第 %d 个通知未选择收件人", ErrAutomationInvalid, index+1)
			}
			if err := s.permService.ValidateEditableUsers(action.UserIDs); err != nil {
				return fmt.Errorf("%w: %v", ErrAutomationInvalid, err)
			}
			if err := s.permService.ValidateDepartments(action.DepartmentIDs); err != nil {
				return fmt.Errorf("%w: %v", ErrAutomationInvalid, err)
			}
		case "channel_message":
			if action.ChannelID == nil || *action.ChannelID <= 0 {
				return fmt.Errorf("%w: 第 %d 个频道动作未选择频道", ErrAutomationInvalid, index+1)
			}
			if err := s.channelService.EnsureChannelAccess(rule.OwnerID, *action.ChannelID); err != nil {
				return fmt.Errorf("%w: 规则负责人无法访问所选频道", ErrAutomationAccessDenied)
			}
			if strings.TrimSpace(action.MessageTemplate) == "" {
				return fmt.Errorf("%w: 第 %d 个频道动作未填写消息内容", ErrAutomationInvalid, index+1)
			}
		case "update_cell":
			action.TargetColumn = strings.TrimSpace(action.TargetColumn)
			if action.TargetColumn == "" {
				return fmt.Errorf("%w: 第 %d 个回写动作未设置列", ErrAutomationInvalid, index+1)
			}
			if _, exists := columnSet[action.TargetColumn]; !exists {
				return fmt.Errorf("%w: 回写列 %q 不存在", ErrAutomationInvalid, action.TargetColumn)
			}
		default:
			return fmt.Errorf("%w: 不支持动作 %q", ErrAutomationInvalid, action.Type)
		}
	}
	return nil
}

func (s *AutomationService) HandleCellChanges(userID int64, changes []model.CellUpdate, source string) {
	if len(changes) == 0 {
		return
	}
	suppressTrigger := source == "automation"
	type rowChanges struct {
		sheetID int64
		row     int
		cols    map[string]any
	}
	grouped := make(map[string]*rowChanges)
	for _, change := range changes {
		key := fmt.Sprintf("%d:%d", change.SheetID, change.Row)
		group := grouped[key]
		if group == nil {
			group = &rowChanges{sheetID: change.SheetID, row: change.Row, cols: make(map[string]any)}
			grouped[key] = group
		}
		var value any
		if len(change.Value) > 0 {
			_ = json.Unmarshal(change.Value, &value)
		}
		group.cols[strings.TrimSpace(change.Col)] = value
	}
	rulesBySheet := make(map[int64][]model.AutomationRule)
	for _, group := range grouped {
		rules, loaded := rulesBySheet[group.sheetID]
		if !loaded {
			sheetID := group.sheetID
			var err error
			rules, err = s.repo.ListEnabledRules("cell_change", &sheetID)
			if err != nil {
				continue
			}
			rulesBySheet[group.sheetID] = rules
		}
		if len(rules) == 0 {
			continue
		}
		rowData, err := s.repo.GetRowData(group.sheetID, group.row)
		if err != nil {
			continue
		}
		for column, value := range group.cols {
			rowData[column] = value
		}
		for index := range rules {
			rule := &rules[index]
			if rule.HoldChanges {
				continue
			}
			if !watchedColumnsIntersect(rule.WatchedColumns, group.cols) {
				continue
			}
			matched := evaluateAutomationConditions(rule.Conditions, rule.ConditionLogic, rowData)
			fingerprint, err := automationRowFingerprint(rule, rowData)
			if err != nil {
				continue
			}
			shouldTrigger, err := s.repo.UpdateTriggerState(rule.ID, group.sheetID, group.row, matched, fingerprint, !suppressTrigger)
			if err != nil || !shouldTrigger {
				continue
			}
			rowIndex := group.row
			sheetID := group.sheetID
			actor := userID
			context := model.AutomationTriggerContext{
				SheetID: &sheetID, RowIndex: &rowIndex, RowData: rowData,
				ChangedValues: group.cols, ChangedCols: sortedAutomationKeys(group.cols),
				TriggeredAt: time.Now(), Metadata: map[string]any{"source": source},
			}
			_, _ = s.triggerRule(rule, context, &actor, "")
		}
	}
}

func (s *AutomationService) TriggerManual(userID, ruleID int64, input *model.ManualAutomationTriggerInput) (*model.AutomationRun, error) {
	rule, err := s.repo.GetRule(ruleID)
	if err != nil {
		return nil, err
	}
	if err := s.ensureRuleManage(userID, rule); err != nil {
		return nil, err
	}
	if !rule.Enabled {
		return nil, fmt.Errorf("%w: 该规则已停用", ErrAutomationInvalid)
	}
	if rule.TriggerType != "manual" {
		return nil, fmt.Errorf("%w: 该规则不是手动触发规则", ErrAutomationInvalid)
	}
	context := model.AutomationTriggerContext{SheetID: rule.SheetID, TriggeredAt: time.Now(), Metadata: map[string]any{}}
	if input != nil {
		context.RowIndex = input.RowIndex
		context.Metadata = input.Metadata
	}
	if context.RowIndex != nil && *context.RowIndex < 0 {
		return nil, fmt.Errorf("%w: 数据行不能小于 0", ErrAutomationInvalid)
	}
	if hasUpdateCellAction(rule.Actions) && context.RowIndex == nil {
		return nil, fmt.Errorf("%w: 此规则包含单元格回写，请指定数据行", ErrAutomationInvalid)
	}
	if rule.SheetID != nil && context.RowIndex != nil {
		rowData, err := s.repo.GetRowData(*rule.SheetID, *context.RowIndex)
		if err != nil {
			return nil, err
		}
		context.RowData = rowData
	}
	if len(rule.Conditions) > 0 {
		if context.RowIndex == nil {
			return nil, fmt.Errorf("%w: 此规则需要指定数据行", ErrAutomationInvalid)
		}
		if !evaluateAutomationConditions(rule.Conditions, rule.ConditionLogic, context.RowData) {
			return nil, fmt.Errorf("%w: 指定数据行不满足规则条件", ErrAutomationInvalid)
		}
	}
	actor := userID
	run, err := s.triggerRule(rule, context, &actor, "")
	if err == nil {
		s.recordAutomationOperation(userID, "automation.run.manual", "手动触发自动化规则", rule, nil, map[string]any{"run_id": run.ID})
	}
	return run, err
}

func (s *AutomationService) executeScheduledRule(ruleID int64, scheduledAt time.Time) {
	rule, err := s.repo.GetRule(ruleID)
	if err != nil || !rule.Enabled || rule.TriggerType != "schedule" {
		return
	}
	baseKey := fmt.Sprintf("schedule:%d:%d", rule.ID, scheduledAt.Unix())
	if rule.SheetID != nil && (len(rule.Conditions) > 0 || hasUpdateCellAction(rule.Actions)) {
		rows, err := s.repo.ListRowData(*rule.SheetID, maxAutomationScheduleRows)
		if err != nil {
			_ = s.repo.UpdateRuleRunResult(rule.ID, "failed", err.Error())
			return
		}
		matchedRows := 0
		for _, row := range rows {
			rowData := make(map[string]any)
			if json.Unmarshal(row.Data, &rowData) != nil || !evaluateAutomationConditions(rule.Conditions, rule.ConditionLogic, rowData) {
				continue
			}
			matchedRows++
			rowIndex := row.RowIndex
			sheetID := *rule.SheetID
			context := model.AutomationTriggerContext{SheetID: &sheetID, RowIndex: &rowIndex, RowData: rowData, TriggeredAt: scheduledAt}
			_, _ = s.triggerRule(rule, context, nil, fmt.Sprintf("%s:%d", baseKey, rowIndex))
		}
		if matchedRows == 0 {
			_ = s.repo.UpdateRuleRunResult(rule.ID, "completed", "本次未找到满足条件的数据行")
		}
		return
	}
	context := model.AutomationTriggerContext{SheetID: rule.SheetID, TriggeredAt: scheduledAt}
	_, _ = s.triggerRule(rule, context, nil, baseKey)
}

func (s *AutomationService) triggerRule(rule *model.AutomationRule, context model.AutomationTriggerContext, triggeredBy *int64, idempotencyKey string) (*model.AutomationRun, error) {
	if err := s.permService.ValidateEditableUsers([]int64{rule.OwnerID}); err != nil {
		_ = s.repo.UpdateRuleRunResult(rule.ID, "failed", "规则负责人已停用或不存在")
		return nil, fmt.Errorf("规则负责人不可用: %w", err)
	}
	seeds, err := s.buildApprovalSeeds(rule.ApprovalSteps)
	if err != nil {
		_ = s.repo.UpdateRuleRunResult(rule.ID, "failed", err.Error())
		return nil, err
	}
	snapshot := model.AutomationRuleSnapshot{
		ID: rule.ID, Name: rule.Name, OwnerID: rule.OwnerID, SheetID: rule.SheetID,
		TriggerType: rule.TriggerType, WatchedColumns: rule.WatchedColumns,
		ConditionLogic: rule.ConditionLogic, Conditions: rule.Conditions,
		ApprovalSteps: rule.ApprovalSteps, ApprovalRanges: rule.ApprovalRanges,
		Actions: rule.Actions, HoldChanges: rule.HoldChanges,
	}
	run, created, err := s.repo.CreateRun(rule, snapshot, context, triggeredBy, idempotencyKey, seeds)
	if err != nil {
		_ = s.repo.UpdateRuleRunResult(rule.ID, "failed", err.Error())
		return nil, err
	}
	if !created {
		return s.repo.GetRun(run.ID)
	}
	if len(seeds) > 0 {
		assignees := approvalSeedUserIDs(seeds[0])
		if err := s.notifyApprovalAssignees(run.ID, rule.Name, seeds[0].Name, assignees); err != nil {
			_ = s.repo.UpdateCellApprovalState(run.ID, "failed")
			_ = s.repo.FinishRun(run.ID, "failed", map[string]any{}, err.Error())
			_ = s.repo.UpdateRuleRunResult(rule.ID, "failed", err.Error())
			s.emitApprovalState([]int64{ruleSheetID(rule)})
			return s.repo.GetRun(run.ID)
		}
		_ = s.repo.UpdateRuleRunResult(rule.ID, "waiting_approval", "等待审批")
		s.emitApprovalState([]int64{ruleSheetID(rule)})
		return s.repo.GetRun(run.ID)
	}
	_ = s.executeRun(run.ID)
	return s.repo.GetRun(run.ID)
}

func (s *AutomationService) executeRun(runID int64) error {
	run, err := s.repo.GetRun(runID)
	if err != nil {
		return err
	}
	if run.Status != "running" {
		return fmt.Errorf("automation run is not executable")
	}
	results := make([]map[string]any, 0, len(run.RuleSnapshot.Actions))
	for index, action := range run.RuleSnapshot.Actions {
		result, err := s.executeAction(run, action)
		if err != nil {
			_ = s.repo.AddRunLog(run.ID, "error", "action.failed", err.Error(), map[string]any{"action_index": index, "action_type": action.Type})
			_ = s.repo.FinishRun(run.ID, "failed", results, err.Error())
			_ = s.repo.UpdateRuleRunResult(run.RuleSnapshot.ID, "failed", err.Error())
			s.notifyRunFailure(run, err)
			return err
		}
		results = append(results, result)
		_ = s.repo.AddRunLog(run.ID, "info", "action.completed", "动作执行成功", map[string]any{"action_index": index, "action_type": action.Type, "result": result})
	}
	if err := s.repo.FinishRun(run.ID, "completed", results, ""); err != nil {
		return err
	}
	_ = s.repo.UpdateRuleRunResult(run.RuleSnapshot.ID, "completed", "执行成功")
	recipients := []int64{run.RuleSnapshot.OwnerID}
	if run.TriggeredBy != nil {
		recipients = append(recipients, *run.TriggeredBy)
	}
	s.emitNotification(recipients)
	return nil
}

func (s *AutomationService) executeAction(run *model.AutomationRun, action model.AutomationAction) (map[string]any, error) {
	variables := automationTemplateVariables(run)
	switch action.Type {
	case "notify":
		recipients, err := s.resolveActionRecipients(run, action)
		if err != nil {
			return nil, err
		}
		title := renderAutomationTemplate(action.TitleTemplate, variables)
		if title == "" {
			title = "自动化提醒：" + run.RuleName
		}
		title = truncateAutomationText(title, 200)
		content := renderAutomationTemplate(action.MessageTemplate, variables)
		metadata, _ := json.Marshal(map[string]any{"run_id": run.ID, "rule_id": run.RuleSnapshot.ID})
		createdFor, err := s.repo.CreateNotifications(recipients, model.UserNotification{
			NotificationType: "automation", Title: title, Content: content,
			LinkURL: fmt.Sprintf("/tasks?run=%d", run.ID), EntityType: "automation_run", EntityID: &run.ID,
			Metadata: metadata,
		})
		if err != nil {
			return nil, err
		}
		s.emitNotification(createdFor)
		return map[string]any{"type": action.Type, "recipients": createdFor}, nil
	case "channel_message":
		if action.ChannelID == nil {
			return nil, fmt.Errorf("频道动作缺少频道")
		}
		content := renderAutomationTemplate(action.MessageTemplate, variables)
		message, err := s.channelService.CreateAutomationMessage(run.RuleSnapshot.OwnerID, *action.ChannelID, content, action.SendWhatsApp)
		if err != nil {
			return nil, err
		}
		return map[string]any{"type": action.Type, "channel_id": *action.ChannelID, "message_id": message.ID, "whatsapp": action.SendWhatsApp}, nil
	case "update_cell":
		if run.SheetID == nil || run.RowIndex == nil {
			return nil, fmt.Errorf("回写动作缺少工作表或行")
		}
		value, err := automationActionValue(action, variables)
		if err != nil {
			return nil, err
		}
		change := model.CellUpdate{SheetID: *run.SheetID, Row: *run.RowIndex, Col: action.TargetColumn, Value: value}
		if err := s.sheetService.UpdateCellsWithSource(run.RuleSnapshot.OwnerID, []model.CellUpdate{change}, "automation"); err != nil {
			return nil, err
		}
		if s.cellBroadcastHook != nil {
			s.cellBroadcastHook(run.RuleSnapshot.OwnerID, []model.CellUpdate{change})
		}
		return map[string]any{"type": action.Type, "sheet_id": *run.SheetID, "row_index": *run.RowIndex, "column": action.TargetColumn}, nil
	default:
		return nil, fmt.Errorf("不支持自动化动作 %q", action.Type)
	}
}

func (s *AutomationService) DecideApproval(userID, requestID int64, input *model.ApprovalDecisionInput) error {
	if input == nil {
		return fmt.Errorf("%w: 审批决定不能为空", ErrAutomationInvalid)
	}
	input.Decision = strings.ToLower(strings.TrimSpace(input.Decision))
	input.Comment = strings.TrimSpace(input.Comment)
	if input.Decision != "approve" && input.Decision != "reject" {
		return fmt.Errorf("%w: 审批决定仅支持 approve/reject", ErrAutomationInvalid)
	}
	if utf8.RuneCountInString(input.Comment) > 1000 {
		return fmt.Errorf("%w: 审批意见不能超过 1000 个字符", ErrAutomationInvalid)
	}
	result, err := s.repo.DecideApproval(requestID, userID, input.Decision, input.Comment)
	if err != nil {
		return err
	}
	notificationUsers := append([]int64{userID, result.OwnerID}, result.NextAssigneeIDs...)
	if result.TriggeredBy != nil {
		notificationUsers = append(notificationUsers, *result.TriggeredBy)
	}
	s.emitNotification(notificationUsers)
	run, _ := s.repo.GetRun(result.RunID)
	if run != nil {
		s.recordAutomationOperation(userID, "automation.approval."+input.Decision, "提交自动化审批意见", nil, nil, map[string]any{
			"request_id": requestID, "run_id": result.RunID, "rule_name": run.RuleName, "comment": input.Comment,
		})
	}
	if result.RunStatus == "rejected" {
		if run != nil {
			_ = s.repo.UpdateCellApprovalState(run.ID, "rejected")
			_ = s.repo.UpdateRuleRunResult(run.RuleSnapshot.ID, "rejected", "审批已拒绝")
			recipients := []int64{result.OwnerID}
			if result.TriggeredBy != nil {
				recipients = append(recipients, *result.TriggeredBy)
			}
			s.createSystemNotification(recipients, "审批已拒绝："+run.RuleName, strings.TrimSpace(input.Comment), result.RunID)
		}
		if run != nil && run.SheetID != nil {
			s.emitApprovalState([]int64{*run.SheetID})
		}
		return nil
	}
	if result.NextRequestID != nil && run != nil {
		steps := run.RuleSnapshot.ApprovalSteps
		stepName := "下一审批步骤"
		if run.CurrentStep >= 0 && run.CurrentStep < len(steps) {
			stepName = steps[run.CurrentStep].Name
		}
		if err := s.notifyApprovalAssignees(result.RunID, run.RuleName, stepName, result.NextAssigneeIDs); err != nil {
			_ = s.repo.AddRunLog(result.RunID, "warning", "approval.notification_failed", err.Error(), map[string]any{"request_id": *result.NextRequestID})
			s.emitNotification(result.NextAssigneeIDs)
		}
		return nil
	}
	if result.RunStatus == "running" {
		if run != nil && run.RuleSnapshot.HoldChanges {
			if err := s.applyApprovedPendingChanges(run); err != nil {
				_ = s.repo.UpdateCellApprovalState(run.ID, "failed")
				_ = s.repo.FinishRun(run.ID, "failed", map[string]any{}, err.Error())
				_ = s.repo.UpdateRuleRunResult(run.RuleSnapshot.ID, "failed", err.Error())
				if run.SheetID != nil {
					s.emitApprovalState([]int64{*run.SheetID})
				}
				return nil
			}
		}
		_ = s.executeRun(result.RunID)
		return nil
	}
	return nil
}

func (s *AutomationService) InterceptCellChanges(userID int64, changes []model.CellUpdate, source string) (*model.CellUpdateResult, error) {
	result := &model.CellUpdateResult{AppliedChanges: append([]model.CellUpdate(nil), changes...)}
	if len(changes) == 0 || source == "approval" || source == "automation" || source == "import" || source == "trade_erp" {
		return result, nil
	}

	type approvalGroup struct {
		rule    *model.AutomationRule
		sheetID int64
		row     int
		changes []model.PendingCellChange
		values  map[string]any
		rowData map[string]any
		labels  map[string]string
	}

	rulesBySheet := make(map[int64][]model.AutomationRule)
	sheets := make(map[int64]*model.Sheet)
	groups := make(map[string]*approvalGroup)
	direct := make([]model.CellUpdate, 0, len(changes))

	for _, change := range changes {
		rules, loaded := rulesBySheet[change.SheetID]
		if !loaded {
			loadedRules, err := s.repo.ListEnabledRules("cell_change", &change.SheetID)
			if err != nil {
				return nil, err
			}
			for _, rule := range loadedRules {
				if rule.HoldChanges {
					rules = append(rules, rule)
				}
			}
			rulesBySheet[change.SheetID] = rules
		}

		matching := make([]*model.AutomationRule, 0, 1)
		for index := range rules {
			rule := &rules[index]
			if automationApprovalRangeMatches(rule, change.Row, change.Col) {
				matching = append(matching, rule)
			}
		}
		if len(matching) == 0 {
			direct = append(direct, change)
			continue
		}
		if len(matching) > 1 {
			return nil, fmt.Errorf("%w: 单元格 %s%d 同时命中多个审批流程，请调整审批范围", ErrAutomationInvalid, change.Col, change.Row+2)
		}
		pending, err := s.repo.HasPendingCellApproval(change.SheetID, change.Row, change.Col)
		if err != nil {
			return nil, err
		}
		if pending {
			return nil, fmt.Errorf("%w: 单元格 %s%d 已有待审批内容，请先完成当前审批", ErrAutomationInvalid, change.Col, change.Row+2)
		}

		sheet := sheets[change.SheetID]
		if sheet == nil {
			sheet, err = s.sheetRepo.GetSheet(change.SheetID)
			if err != nil {
				return nil, err
			}
			sheets[change.SheetID] = sheet
		}
		original := automationCurrentCellValue(sheet, change.Row, change.Col)
		if string(original) == "null" {
			rowData, rowErr := s.repo.GetRowData(change.SheetID, change.Row)
			if rowErr != nil {
				return nil, rowErr
			}
			if value, exists := rowData[change.Col]; exists {
				if encoded, marshalErr := json.Marshal(value); marshalErr == nil {
					original = encoded
				}
			}
		}
		proposed := append(json.RawMessage(nil), change.Value...)
		if len(proposed) == 0 {
			proposed = json.RawMessage("null")
		}
		key := fmt.Sprintf("%d:%d:%d", matching[0].ID, change.SheetID, change.Row)
		group := groups[key]
		if group == nil {
			rowData, err := s.repo.GetRowData(change.SheetID, change.Row)
			if err != nil {
				return nil, err
			}
			group = &approvalGroup{
				rule: matching[0], sheetID: change.SheetID, row: change.Row,
				values: make(map[string]any), rowData: rowData, labels: automationSheetColumnLabels(sheet),
			}
			groups[key] = group
		}
		var proposedValue any
		_ = json.Unmarshal(proposed, &proposedValue)
		group.values[change.Col] = proposedValue
		group.rowData[change.Col] = proposedValue
		group.changes = append(group.changes, model.PendingCellChange{
			SheetID: change.SheetID, Row: change.Row, Col: change.Col,
			ProposedValue: proposed, OriginalValue: original,
		})
	}

	orderedKeys := make([]string, 0, len(groups))
	for key := range groups {
		orderedKeys = append(orderedKeys, key)
	}
	sort.Strings(orderedKeys)
	for _, key := range orderedKeys {
		group := groups[key]
		if !evaluateAutomationConditions(group.rule.Conditions, group.rule.ConditionLogic, group.rowData) {
			for _, pending := range group.changes {
				direct = append(direct, model.CellUpdate{SheetID: pending.SheetID, Row: pending.Row, Col: pending.Col, Value: pending.ProposedValue})
			}
			continue
		}
		rowIndex := group.row
		sheetID := group.sheetID
		actor := userID
		context := model.AutomationTriggerContext{
			SheetID: &sheetID, RowIndex: &rowIndex, RowData: group.rowData,
			ChangedValues: group.values, ChangedCols: sortedAutomationKeys(group.values),
			FieldLabels:    group.labels,
			PendingChanges: group.changes, TriggeredAt: time.Now(),
			Metadata: map[string]any{"source": source, "approval_hold": true},
		}
		run, err := s.triggerRule(group.rule, context, &actor, "")
		if err != nil {
			return nil, err
		}
		states, err := s.repo.ListRunCellApprovalStates(run.ID)
		if err != nil {
			return nil, err
		}
		result.PendingStates = append(result.PendingStates, states...)
		for _, pending := range group.changes {
			result.RevertedChanges = append(result.RevertedChanges, model.CellUpdate{
				SheetID: pending.SheetID, Row: pending.Row, Col: pending.Col, Value: pending.OriginalValue,
			})
		}
	}
	result.AppliedChanges = direct
	return result, nil
}

func (s *AutomationService) ListCellApprovalStates(userID, sheetID int64) ([]model.CellApprovalState, error) {
	matrix, err := s.permService.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return nil, err
	}
	if matrix == nil || !matrix.Sheet.CanView {
		return nil, ErrAutomationAccessDenied
	}
	states, err := s.repo.ListCellApprovalStates(sheetID, 1000)
	if err != nil {
		return nil, err
	}
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	defaultLabels := automationSheetColumnLabels(sheet)
	for index := range states {
		filtered, err := s.sheetService.RealtimeCellChangesForUser(sheetID, userID, []model.CellUpdate{
			{SheetID: sheetID, Row: states[index].Row, Col: states[index].Col, Value: states[index].ProposedValue},
			{SheetID: sheetID, Row: states[index].Row, Col: states[index].Col, Value: states[index].OriginalValue},
		})
		if err != nil || len(filtered) < 2 {
			states[index].ProposedValue = nil
			states[index].OriginalValue = nil
			continue
		}
		states[index].ProposedValue = filtered[0].Value
		states[index].OriginalValue = filtered[1].Value
		visibleRelated, err := s.filterAutomationValuesForUser(sheetID, userID, states[index].Row, states[index].RelatedData)
		if err != nil {
			states[index].RelatedData = nil
		} else {
			states[index].RelatedData = visibleRelated
		}
		if len(states[index].FieldLabels) == 0 {
			states[index].FieldLabels = defaultLabels
		}
		states[index].FieldLabels = visibleAutomationLabels(states[index].FieldLabels, states[index].RelatedData, states[index].Col)
	}
	return states, nil
}

func (s *AutomationService) applyApprovedPendingChanges(run *model.AutomationRun) error {
	if run == nil || len(run.TriggerContext.PendingChanges) == 0 {
		return nil
	}
	actorID := run.RuleSnapshot.OwnerID
	if run.TriggeredBy != nil {
		actorID = *run.TriggeredBy
	}
	changes := make([]model.CellUpdate, 0, len(run.TriggerContext.PendingChanges))
	for _, pending := range run.TriggerContext.PendingChanges {
		changes = append(changes, model.CellUpdate{
			SheetID: pending.SheetID, Row: pending.Row, Col: pending.Col,
			Value: append(json.RawMessage(nil), pending.ProposedValue...),
		})
	}
	if _, err := s.sheetService.UpdateCellsWithSourceDetailed(actorID, changes, "approval"); err != nil {
		return fmt.Errorf("审批通过但正式写入失败: %w", err)
	}
	if err := s.repo.UpdateCellApprovalState(run.ID, "approved"); err != nil {
		return err
	}
	if s.cellBroadcastHook != nil {
		s.cellBroadcastHook(actorID, changes)
	}
	if run.SheetID != nil {
		s.emitApprovalState([]int64{*run.SheetID})
	}
	return nil
}

func (s *AutomationService) emitApprovalState(sheetIDs []int64) {
	if s.approvalStateHook == nil {
		return
	}
	seen := make(map[int64]struct{}, len(sheetIDs))
	clean := make([]int64, 0, len(sheetIDs))
	for _, sheetID := range sheetIDs {
		if sheetID <= 0 {
			continue
		}
		if _, exists := seen[sheetID]; exists {
			continue
		}
		seen[sheetID] = struct{}{}
		clean = append(clean, sheetID)
	}
	if len(clean) > 0 {
		s.approvalStateHook(clean)
	}
}

func ruleSheetID(rule *model.AutomationRule) int64 {
	if rule == nil || rule.SheetID == nil {
		return 0
	}
	return *rule.SheetID
}

func automationApprovalRangeMatches(rule *model.AutomationRule, row int, col string) bool {
	if rule == nil || !rule.HoldChanges || !watchedColumnsIntersect(rule.WatchedColumns, map[string]any{col: true}) {
		return false
	}
	if len(rule.ApprovalRanges) == 0 {
		return true
	}
	for _, target := range rule.ApprovalRanges {
		rowMatch := target.StartRow == nil && target.EndRow == nil
		if target.StartRow != nil && target.EndRow != nil {
			rowMatch = row >= *target.StartRow && row <= *target.EndRow
		}
		if !rowMatch {
			continue
		}
		if len(target.Columns) == 0 {
			return true
		}
		for _, column := range target.Columns {
			if column == col {
				return true
			}
		}
	}
	return false
}

func validateAutomationApprovalRanges(ranges []model.AutomationApprovalRange, columnSet map[string]struct{}) error {
	for index := range ranges {
		target := &ranges[index]
		target.Columns = normalizeAutomationColumns(target.Columns)
		if (target.StartRow == nil) != (target.EndRow == nil) {
			return fmt.Errorf("%w: 第 %d 个审批范围的起止行必须同时设置", ErrAutomationInvalid, index+1)
		}
		if target.StartRow != nil && (*target.StartRow < 0 || *target.EndRow < *target.StartRow) {
			return fmt.Errorf("%w: 第 %d 个审批范围行号无效", ErrAutomationInvalid, index+1)
		}
		for _, column := range target.Columns {
			if _, exists := columnSet[column]; !exists {
				return fmt.Errorf("%w: 审批范围列 %q 不存在", ErrAutomationInvalid, column)
			}
		}
	}
	return nil
}

func automationSheetColumnLabels(sheet *model.Sheet) map[string]string {
	if sheet == nil || len(sheet.Columns) == 0 {
		return nil
	}
	var columns []struct {
		Key  string `json:"key"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(sheet.Columns, &columns); err != nil {
		return nil
	}
	labels := make(map[string]string, len(columns))
	for _, column := range columns {
		key := strings.TrimSpace(column.Key)
		if key == "" {
			continue
		}
		label := strings.TrimSpace(column.Name)
		if label == "" {
			label = key
		}
		labels[key] = label
	}
	if len(labels) == 0 {
		return nil
	}
	return labels
}

func (s *AutomationService) filterAutomationValuesForUser(sheetID, userID int64, row int, values map[string]any) (map[string]any, error) {
	if len(values) == 0 {
		return nil, nil
	}
	changes := make([]model.CellUpdate, 0, len(values))
	for column, value := range values {
		if strings.TrimSpace(column) == "" {
			continue
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		changes = append(changes, model.CellUpdate{SheetID: sheetID, Row: row, Col: column, Value: raw})
	}
	filtered, err := s.sheetService.RealtimeCellChangesForUser(sheetID, userID, changes)
	if err != nil {
		return nil, err
	}
	visible := make(map[string]any, len(filtered))
	for _, change := range filtered {
		var value any
		if len(change.Value) > 0 {
			if err := json.Unmarshal(change.Value, &value); err != nil {
				return nil, err
			}
		}
		visible[change.Col] = value
	}
	if len(visible) == 0 {
		return nil, nil
	}
	return visible, nil
}

func visibleAutomationLabels(labels map[string]string, visibleData map[string]any, extraColumns ...string) map[string]string {
	if len(labels) == 0 {
		return nil
	}
	allowed := make(map[string]struct{}, len(visibleData)+len(extraColumns))
	for column := range visibleData {
		allowed[column] = struct{}{}
	}
	for _, column := range extraColumns {
		if strings.TrimSpace(column) != "" {
			allowed[column] = struct{}{}
		}
	}
	result := make(map[string]string, len(allowed))
	for column := range allowed {
		if label := strings.TrimSpace(labels[column]); label != "" {
			result[column] = label
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func automationCurrentCellValue(sheet *model.Sheet, row int, col string) json.RawMessage {
	if sheet == nil {
		return json.RawMessage("null")
	}
	columnKeys, _ := parseColumnKeys(sheet.Columns)
	columnIndex := -1
	for index, key := range columnKeys {
		if key == col {
			columnIndex = index
			break
		}
	}
	if columnIndex >= 0 && len(sheet.Config) > 0 {
		var config struct {
			UniverSheetData struct {
				CellData map[string]map[string]json.RawMessage `json:"cellData"`
			} `json:"univerSheetData"`
		}
		if json.Unmarshal(sheet.Config, &config) == nil {
			if raw := config.UniverSheetData.CellData[strconv.Itoa(row+1)][strconv.Itoa(columnIndex)]; len(raw) > 0 {
				var cell struct {
					Value   json.RawMessage `json:"v"`
					Formula string          `json:"f"`
				}
				if json.Unmarshal(raw, &cell) == nil {
					if strings.TrimSpace(cell.Formula) != "" {
						encoded, _ := json.Marshal(cell.Formula)
						return encoded
					}
					if len(cell.Value) > 0 {
						return cell.Value
					}
				}
			}
		}
	}
	return json.RawMessage("null")
}

func (s *AutomationService) GetRunDetail(userID, runID int64) (*model.AutomationRunDetail, error) {
	run, err := s.repo.GetRun(runID)
	if err != nil {
		return nil, err
	}
	if err := s.ensureRunAccess(userID, run); err != nil {
		return nil, err
	}
	privileged, err := s.maskRunForUser(userID, run)
	if err != nil {
		return nil, err
	}
	approvals, err := s.repo.ListRunApprovals(runID)
	if err != nil {
		return nil, err
	}
	logs, err := s.repo.ListRunLogs(runID)
	if err != nil {
		return nil, err
	}
	if !privileged {
		for index := range logs {
			logs[index].Details = nil
		}
	}
	return &model.AutomationRunDetail{Run: run, Approvals: approvals, Logs: logs}, nil
}

func (s *AutomationService) ListRuns(userID int64, status string, page, size int) ([]model.AutomationRun, int64, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, 0, err
	}
	page, size = normalizeAutomationPage(page, size, 100)
	runs, total, err := s.repo.ListRuns(userID, isAdmin, strings.TrimSpace(status), page, size)
	if err != nil {
		return nil, 0, err
	}
	for index := range runs {
		if _, err := s.maskRunForUserWithAdmin(userID, isAdmin, &runs[index]); err != nil {
			return nil, 0, err
		}
	}
	return runs, total, nil
}

func (s *AutomationService) ListPendingApprovals(userID int64, page, size int) ([]model.ApprovalRequest, int64, error) {
	page, size = normalizeAutomationPage(page, size, 100)
	items, total, err := s.repo.ListPendingApprovals(userID, page, size)
	if err != nil {
		return nil, 0, err
	}
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, 0, err
	}
	for index := range items {
		if items[index].Run == nil {
			continue
		}
		if _, err := s.maskRunForUserWithAdmin(userID, isAdmin, items[index].Run); err != nil {
			return nil, 0, err
		}
	}
	return items, total, nil
}

func (s *AutomationService) ListNotifications(userID int64, unreadOnly bool, category string, page, size int) ([]model.UserNotification, int64, error) {
	page, size = normalizeAutomationPage(page, size, 100)
	if category != "erp" && category != "system" {
		category = ""
	}
	return s.repo.ListNotifications(userID, unreadOnly, category, page, size)
}

func (s *AutomationService) MarkNotificationRead(userID, notificationID int64) error {
	if err := s.repo.MarkNotificationRead(userID, notificationID); err != nil {
		return err
	}
	s.emitNotification([]int64{userID})
	return nil
}

func (s *AutomationService) MarkAllNotificationsRead(userID int64, category string) error {
	if category != "erp" && category != "system" {
		category = ""
	}
	if err := s.repo.MarkAllNotificationsRead(userID, category); err != nil {
		return err
	}
	s.emitNotification([]int64{userID})
	return nil
}

func (s *AutomationService) TaskCenterSummary(userID int64) (*model.TaskCenterSummary, error) {
	return s.repo.TaskCenterSummary(userID)
}

func (s *AutomationService) ensureRuleManage(userID int64, rule *model.AutomationRule) error {
	if rule.OwnerID == userID {
		return nil
	}
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if !isAdmin {
		return ErrAutomationAccessDenied
	}
	return nil
}

func (s *AutomationService) ensureRunAccess(userID int64, run *model.AutomationRun) error {
	if run.TriggeredBy != nil && *run.TriggeredBy == userID || run.RuleSnapshot.OwnerID == userID {
		return nil
	}
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	allowed, err := s.repo.IsRunAssignee(run.ID, userID)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrAutomationAccessDenied
	}
	return nil
}

func (s *AutomationService) maskRunForUser(userID int64, run *model.AutomationRun) (bool, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return false, err
	}
	return s.maskRunForUserWithAdmin(userID, isAdmin, run)
}

func (s *AutomationService) maskRunForUserWithAdmin(userID int64, isAdmin bool, run *model.AutomationRun) (bool, error) {
	if run == nil {
		return false, nil
	}
	if run.SheetID != nil && len(run.TriggerContext.FieldLabels) == 0 {
		sheet, err := s.sheetRepo.GetSheet(*run.SheetID)
		if err == nil {
			run.TriggerContext.FieldLabels = automationSheetColumnLabels(sheet)
		}
	}
	if isAdmin || run.RuleSnapshot.OwnerID == userID {
		return true, nil
	}

	run.RuleSnapshot.WatchedColumns = nil
	run.RuleSnapshot.Conditions = nil
	run.RuleSnapshot.ApprovalSteps = nil
	run.RuleSnapshot.ApprovalRanges = nil
	run.RuleSnapshot.Actions = nil
	run.Result = nil
	run.TriggerContext.Metadata = nil

	if run.SheetID == nil || run.RowIndex == nil {
		run.TriggerContext.RowData = nil
		run.TriggerContext.ChangedValues = nil
		run.TriggerContext.ChangedCols = nil
		run.TriggerContext.FieldLabels = nil
		run.TriggerContext.PendingChanges = nil
		return false, nil
	}

	combined := make(map[string]any, len(run.TriggerContext.RowData)+len(run.TriggerContext.ChangedValues))
	for column, value := range run.TriggerContext.RowData {
		combined[column] = value
	}
	for column, value := range run.TriggerContext.ChangedValues {
		combined[column] = value
	}
	changes := make([]model.CellUpdate, 0, len(combined))
	for column, value := range combined {
		if strings.TrimSpace(column) == "" {
			continue
		}
		raw, err := json.Marshal(value)
		if err != nil {
			return false, err
		}
		changes = append(changes, model.CellUpdate{SheetID: *run.SheetID, Row: *run.RowIndex, Col: column, Value: raw})
	}
	filtered, err := s.sheetService.RealtimeCellChangesForUser(*run.SheetID, userID, changes)
	if err != nil {
		run.TriggerContext.RowData = nil
		run.TriggerContext.ChangedValues = nil
		return false, nil
	}
	visible := make(map[string]any, len(filtered))
	for _, change := range filtered {
		var value any
		if len(change.Value) > 0 {
			if err := json.Unmarshal(change.Value, &value); err != nil {
				return false, err
			}
		}
		visible[change.Col] = value
	}
	rowData := make(map[string]any, len(run.TriggerContext.RowData))
	for column := range run.TriggerContext.RowData {
		if value, exists := visible[column]; exists {
			rowData[column] = value
		}
	}
	changedValues := make(map[string]any, len(run.TriggerContext.ChangedValues))
	for column := range run.TriggerContext.ChangedValues {
		if value, exists := visible[column]; exists {
			changedValues[column] = value
		}
	}
	run.TriggerContext.RowData = rowData
	run.TriggerContext.ChangedValues = changedValues
	run.TriggerContext.ChangedCols = sortedAutomationKeys(changedValues)

	visiblePending := make([]model.PendingCellChange, 0, len(run.TriggerContext.PendingChanges))
	for _, pending := range run.TriggerContext.PendingChanges {
		filteredValues, err := s.sheetService.RealtimeCellChangesForUser(*run.SheetID, userID, []model.CellUpdate{
			{SheetID: *run.SheetID, Row: pending.Row, Col: pending.Col, Value: pending.ProposedValue},
			{SheetID: *run.SheetID, Row: pending.Row, Col: pending.Col, Value: pending.OriginalValue},
		})
		if err != nil || len(filteredValues) < 2 {
			continue
		}
		pending.ProposedValue = filteredValues[0].Value
		pending.OriginalValue = filteredValues[1].Value
		visiblePending = append(visiblePending, pending)
	}
	run.TriggerContext.PendingChanges = visiblePending
	run.TriggerContext.FieldLabels = visibleAutomationLabels(
		run.TriggerContext.FieldLabels,
		rowData,
		run.TriggerContext.ChangedCols...,
	)
	return false, nil
}

func (s *AutomationService) buildApprovalSeeds(steps []model.AutomationApprovalStep) ([]model.ApprovalRequestSeed, error) {
	result := make([]model.ApprovalRequestSeed, 0, len(steps))
	for index, step := range steps {
		if err := s.permService.ValidateEditableUsers(step.UserIDs); err != nil {
			return nil, fmt.Errorf("审批步骤 %d 包含不可用员工: %w", index+1, err)
		}
		assignees, err := s.resolveApprovalAssignees(step)
		if err != nil {
			return nil, err
		}
		if len(assignees) == 0 || step.RequiredApprovals > len(assignees) {
			return nil, fmt.Errorf("审批步骤 %d 当前没有足够的有效审批人", index+1)
		}
		result = append(result, model.ApprovalRequestSeed{
			StepIndex: index, Name: step.Name, RequiredApprovals: step.RequiredApprovals, Assignees: assignees,
		})
	}
	return result, nil
}

func (s *AutomationService) resolveApprovalAssignees(step model.AutomationApprovalStep) ([]model.ApprovalAssigneeSeed, error) {
	departmentUsers, err := s.repo.ResolveDepartmentUsers(step.DepartmentIDs)
	if err != nil {
		return nil, err
	}
	seen := make(map[int64]struct{})
	result := make([]model.ApprovalAssigneeSeed, 0)
	for _, userID := range normalizeAutomationIDs(step.UserIDs) {
		seen[userID] = struct{}{}
		result = append(result, model.ApprovalAssigneeSeed{UserID: userID, SourceType: "user"})
	}
	for _, departmentID := range normalizeAutomationIDs(step.DepartmentIDs) {
		for _, userID := range departmentUsers[departmentID] {
			if _, exists := seen[userID]; exists {
				continue
			}
			seen[userID] = struct{}{}
			sourceID := departmentID
			result = append(result, model.ApprovalAssigneeSeed{UserID: userID, SourceType: "department", SourceID: &sourceID})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UserID < result[j].UserID })
	return result, nil
}

func (s *AutomationService) resolveActionRecipients(run *model.AutomationRun, action model.AutomationAction) ([]int64, error) {
	switch action.RecipientType {
	case "owner", "":
		return []int64{run.RuleSnapshot.OwnerID}, nil
	case "trigger_user":
		if run.TriggeredBy == nil {
			return []int64{run.RuleSnapshot.OwnerID}, nil
		}
		return []int64{*run.TriggeredBy}, nil
	case "users_departments":
		departmentUsers, err := s.repo.ResolveDepartmentUsers(action.DepartmentIDs)
		if err != nil {
			return nil, err
		}
		ids := append([]int64(nil), action.UserIDs...)
		for _, departmentID := range action.DepartmentIDs {
			ids = append(ids, departmentUsers[departmentID]...)
		}
		return normalizeAutomationIDs(ids), nil
	default:
		return nil, fmt.Errorf("无效通知收件人")
	}
}

func (s *AutomationService) notifyApprovalAssignees(runID int64, ruleName, stepName string, userIDs []int64) error {
	metadata, _ := json.Marshal(map[string]any{"run_id": runID})
	createdFor, err := s.repo.CreateNotifications(userIDs, model.UserNotification{
		NotificationType: "approval", Title: "待审批：" + ruleName,
		Content: stepName, LinkURL: fmt.Sprintf("/tasks?tab=approvals&run=%d", runID),
		EntityType: "automation_run", EntityID: &runID, Metadata: metadata,
	})
	if err == nil {
		s.emitNotification(createdFor)
	}
	return err
}

func (s *AutomationService) createSystemNotification(userIDs []int64, title, content string, runID int64) {
	metadata, _ := json.Marshal(map[string]any{"run_id": runID})
	createdFor, _ := s.repo.CreateNotifications(userIDs, model.UserNotification{
		NotificationType: "automation", Title: title, Content: content,
		LinkURL: fmt.Sprintf("/tasks?run=%d", runID), EntityType: "automation_run", EntityID: &runID,
		Metadata: metadata,
	})
	s.emitNotification(createdFor)
}

func (s *AutomationService) notifyRunFailure(run *model.AutomationRun, runError error) {
	recipients := []int64{run.RuleSnapshot.OwnerID}
	if run.TriggeredBy != nil {
		recipients = append(recipients, *run.TriggeredBy)
	}
	s.createSystemNotification(recipients, "自动化执行失败："+run.RuleName, runError.Error(), run.ID)
}

func (s *AutomationService) emitNotification(userIDs []int64) {
	if s.notificationHook != nil {
		s.notificationHook(normalizeAutomationIDs(userIDs))
	}
}

func (s *AutomationService) recordAutomationOperation(userID int64, action, summary string, rule *model.AutomationRule, oldValue, newValue any) {
	event := model.OperationEvent{
		UserID: userID, ResourceType: "automation_rule", Action: action,
		Source: "web", Summary: summary, OldValue: oldValue, NewValue: newValue,
	}
	if rule != nil {
		event.ResourceID = rule.ID
		if rule.SheetID != nil {
			event.SheetID = *rule.SheetID
		}
		event.Metadata = map[string]any{"rule_id": rule.ID, "rule_name": rule.Name, "trigger_type": rule.TriggerType}
	} else {
		event.Metadata = newValue
	}
	_ = s.sheetService.RecordOperation(event)
}

func (s *AutomationService) registerSchedule(rule *model.AutomationRule) error {
	if rule == nil || !rule.Enabled || rule.TriggerType != "schedule" {
		return nil
	}
	expression := fmt.Sprintf("CRON_TZ=%s %s", rule.Timezone, rule.CronExpr)
	ruleID := rule.ID
	entryID, err := s.cron.AddFunc(expression, func() { s.executeScheduledRule(ruleID, time.Now()) })
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.entryIDs[rule.ID] = entryID
	s.mu.Unlock()
	return nil
}

func (s *AutomationService) reloadSchedule(rule *model.AutomationRule) error {
	s.removeSchedule(rule.ID)
	return s.registerSchedule(rule)
}

func (s *AutomationService) removeSchedule(ruleID int64) {
	s.mu.Lock()
	entryID, exists := s.entryIDs[ruleID]
	if exists {
		delete(s.entryIDs, ruleID)
	}
	s.mu.Unlock()
	if exists {
		s.cron.Remove(entryID)
	}
}

func (s *AutomationService) attachNextRun(rule *model.AutomationRule) {
	if rule == nil {
		return
	}
	s.mu.RLock()
	entryID, exists := s.entryIDs[rule.ID]
	s.mu.RUnlock()
	if !exists {
		return
	}
	next := s.cron.Entry(entryID).Next
	if !next.IsZero() {
		rule.NextRunAt = &next
	}
}

func validAutomationOperator(operator string) bool {
	switch operator {
	case "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "is_empty", "not_empty", "in", "regex":
		return true
	default:
		return false
	}
}

func evaluateAutomationConditions(conditions []model.AutomationCondition, logic string, rowData map[string]any) bool {
	if len(conditions) == 0 {
		return true
	}
	matched := 0
	for _, condition := range conditions {
		if evaluateAutomationCondition(rowData[condition.Column], condition.Operator, condition.Value) {
			matched++
		}
	}
	if logic == "any" {
		return matched > 0
	}
	return matched == len(conditions)
}

func evaluateAutomationCondition(actual any, operator string, expected any) bool {
	switch operator {
	case "is_empty":
		return automationValueEmpty(actual)
	case "not_empty":
		return !automationValueEmpty(actual)
	case "eq":
		return automationValuesEqual(actual, expected)
	case "neq":
		return !automationValuesEqual(actual, expected)
	case "gt", "gte", "lt", "lte":
		comparison, comparable := compareAutomationValues(actual, expected)
		if !comparable {
			return false
		}
		switch operator {
		case "gt":
			return comparison > 0
		case "gte":
			return comparison >= 0
		case "lt":
			return comparison < 0
		default:
			return comparison <= 0
		}
	case "contains", "not_contains":
		contains := strings.Contains(strings.ToLower(fmt.Sprint(actual)), strings.ToLower(fmt.Sprint(expected)))
		if operator == "not_contains" {
			return !contains
		}
		return contains
	case "in":
		values := automationExpectedList(expected)
		for _, value := range values {
			if automationValuesEqual(actual, value) {
				return true
			}
		}
		return false
	case "regex":
		compiled, err := regexp.Compile(fmt.Sprint(expected))
		return err == nil && compiled.MatchString(fmt.Sprint(actual))
	default:
		return false
	}
}

func compareAutomationValues(left, right any) (int, bool) {
	leftNumber, leftOK := automationNumber(left)
	rightNumber, rightOK := automationNumber(right)
	if leftOK && rightOK {
		switch {
		case leftNumber < rightNumber:
			return -1, true
		case leftNumber > rightNumber:
			return 1, true
		default:
			return 0, true
		}
	}
	leftText := strings.TrimSpace(fmt.Sprint(left))
	rightText := strings.TrimSpace(fmt.Sprint(right))
	if leftText == "" || rightText == "" {
		return 0, false
	}
	return strings.Compare(leftText, rightText), true
}

func automationNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func automationValuesEqual(left, right any) bool {
	if leftNumber, leftOK := automationNumber(left); leftOK {
		if rightNumber, rightOK := automationNumber(right); rightOK {
			return leftNumber == rightNumber
		}
	}
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return bytes.Equal(leftJSON, rightJSON) || strings.EqualFold(strings.TrimSpace(fmt.Sprint(left)), strings.TrimSpace(fmt.Sprint(right)))
}

func automationValueEmpty(value any) bool {
	if value == nil {
		return true
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	case map[string]any:
		return len(typed) == 0
	default:
		return false
	}
}

func automationExpectedList(value any) []any {
	if values, ok := value.([]any); ok {
		return values
	}
	parts := strings.Split(fmt.Sprint(value), ",")
	result := make([]any, 0, len(parts))
	for _, part := range parts {
		result = append(result, strings.TrimSpace(part))
	}
	return result
}

func automationRowFingerprint(rule *model.AutomationRule, rowData map[string]any) (string, error) {
	payload := make(map[string]any)
	columns := rule.WatchedColumns
	if len(columns) == 0 {
		for column, value := range rowData {
			payload[column] = value
		}
	} else {
		for _, column := range columns {
			payload[column] = rowData[column]
		}
	}
	for _, condition := range rule.Conditions {
		payload[condition.Column] = rowData[condition.Column]
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func automationTemplateVariables(run *model.AutomationRun) map[string]string {
	variables := map[string]string{
		"rule.name": run.RuleName, "sheet.name": run.SheetName, "workbook.name": run.WorkbookName,
		"now": time.Now().Format("2006-01-02 15:04:05"),
	}
	if run.RowIndex != nil {
		variables["row.number"] = strconv.Itoa(*run.RowIndex + 2)
		variables["row.index"] = strconv.Itoa(*run.RowIndex)
	}
	if run.TriggeredBy != nil {
		variables["trigger.user_id"] = strconv.FormatInt(*run.TriggeredBy, 10)
	}
	for key, value := range run.TriggerContext.RowData {
		text := automationDisplayValue(value)
		variables[key] = text
		variables["row."+key] = text
	}
	return variables
}

func renderAutomationTemplate(template string, variables map[string]string) string {
	return strings.TrimSpace(templateVariablePattern.ReplaceAllStringFunc(template, func(match string) string {
		parts := templateVariablePattern.FindStringSubmatch(match)
		if len(parts) != 2 {
			return match
		}
		if value, exists := variables[strings.TrimSpace(parts[1])]; exists {
			return value
		}
		return match
	}))
}

func automationActionValue(action model.AutomationAction, variables map[string]string) (json.RawMessage, error) {
	if strings.TrimSpace(action.ValueTemplate) != "" {
		rendered := renderAutomationTemplate(action.ValueTemplate, variables)
		if json.Valid([]byte(rendered)) {
			return json.RawMessage(rendered), nil
		}
		return json.Marshal(rendered)
	}
	return json.Marshal(action.Value)
}

func automationDisplayValue(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		raw, err := json.Marshal(typed)
		if err == nil {
			return string(raw)
		}
		return fmt.Sprint(typed)
	}
}

func truncateAutomationText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func watchedColumnsIntersect(watched []string, changed map[string]any) bool {
	if len(watched) == 0 {
		return true
	}
	for _, column := range watched {
		if _, exists := changed[column]; exists {
			return true
		}
	}
	return false
}

func normalizeAutomationColumns(columns []string) []string {
	seen := make(map[string]struct{}, len(columns))
	result := make([]string, 0, len(columns))
	for _, column := range columns {
		column = strings.TrimSpace(column)
		if column == "" {
			continue
		}
		if _, exists := seen[column]; exists {
			continue
		}
		seen[column] = struct{}{}
		result = append(result, column)
	}
	sort.Strings(result)
	return result
}

func normalizeAutomationIDs(ids []int64) []int64 {
	seen := make(map[int64]struct{}, len(ids))
	result := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func sortedAutomationKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func approvalSeedUserIDs(seed model.ApprovalRequestSeed) []int64 {
	ids := make([]int64, 0, len(seed.Assignees))
	for _, assignee := range seed.Assignees {
		ids = append(ids, assignee.UserID)
	}
	return ids
}

func hasUpdateCellAction(actions []model.AutomationAction) bool {
	for _, action := range actions {
		if strings.EqualFold(strings.TrimSpace(action.Type), "update_cell") {
			return true
		}
	}
	return false
}

func normalizeAutomationPage(page, size, maxSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 20
	}
	if size > maxSize {
		size = maxSize
	}
	return page, size
}
