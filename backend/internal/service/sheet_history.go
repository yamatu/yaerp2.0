package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

var ErrSheetHistoryDetailsDenied = errors.New("sheet history details denied")
var ErrSheetVersionRestoreDenied = errors.New("sheet version restore denied")

const (
	sheetVersionCoalesceWindow = 5 * time.Minute
	sheetVersionDiffCellLimit  = 500
	sheetVersionMaxRows        = 100000
)

type SheetHistoryService struct {
	historyRepo *repo.SheetHistoryRepo
	sheetRepo   *repo.SheetRepo
	permService *PermissionService
}

type sheetMutationHistory struct {
	UserID     int64
	SheetID    int64
	Before     json.RawMessage
	Source     string
	Action     string
	Summary    string
	Coalesce   bool
	OldValue   any
	NewValue   any
	Metadata   any
	PreparedAt time.Time
}

func NewSheetHistoryService(historyRepo *repo.SheetHistoryRepo, sheetRepo *repo.SheetRepo, permService *PermissionService) *SheetHistoryService {
	return &SheetHistoryService{historyRepo: historyRepo, sheetRepo: sheetRepo, permService: permService}
}

func (s *SheetHistoryService) prepareMutation(userID, sheetID int64, source, action, summary string, coalesce bool) (*sheetMutationHistory, error) {
	if s == nil || s.historyRepo == nil {
		return nil, nil
	}
	snapshot, err := s.historyRepo.LoadSheetSnapshot(sheetID)
	if err != nil {
		return nil, err
	}
	if _, _, err := s.captureSnapshot(model.SheetVersionCapture{
		UserID: userID, SheetID: sheetID, Source: "baseline",
		Summary: "历史记录初始状态",
	}, snapshot); err != nil {
		return nil, err
	}
	return &sheetMutationHistory{
		UserID: userID, SheetID: sheetID, Before: snapshot,
		Source: normalizeHistorySource(source), Action: action,
		Summary: strings.TrimSpace(summary), Coalesce: coalesce, PreparedAt: time.Now(),
	}, nil
}

func (s *SheetHistoryService) completeMutation(history *sheetMutationHistory) error {
	if s == nil || history == nil || s.historyRepo == nil {
		return nil
	}
	after, err := s.historyRepo.LoadSheetSnapshot(history.SheetID)
	if err != nil {
		return err
	}
	beforeChecksum, err := sheetSnapshotChecksum(history.Before)
	if err != nil {
		return err
	}
	afterChecksum, err := sheetSnapshotChecksum(after)
	if err != nil {
		return err
	}
	if beforeChecksum == afterChecksum {
		return nil
	}

	version, changed, err := s.captureSnapshot(model.SheetVersionCapture{
		UserID: history.UserID, SheetID: history.SheetID, Source: history.Source,
		Summary: history.Summary, Coalesce: history.Coalesce,
	}, after)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}

	metadata := metadataMap(history.Metadata)
	_, beforeSnapshot, _, normalizeBeforeErr := normalizeSheetVersionSnapshot(history.Before)
	_, afterSnapshot, _, normalizeAfterErr := normalizeSheetVersionSnapshot(after)
	if normalizeBeforeErr == nil && normalizeAfterErr == nil {
		diff := buildSheetVersionDiff(beforeSnapshot, afterSnapshot, 100)
		metadata["changed_cells"] = diff.ChangedCells
		metadata["added_rows"] = diff.AddedRows
		metadata["removed_rows"] = diff.RemovedRows
		metadata["modified_rows"] = diff.ModifiedRows
		metadata["field_changes"] = diff.FieldChanges
		metadata["cell_changes"] = diff.CellChanges
		metadata["cell_changes_limited"] = diff.CellChangesLimited
		if history.OldValue == nil && history.NewValue == nil && len(diff.CellChanges) == 1 {
			history.OldValue = diff.CellChanges[0].OldValue
			history.NewValue = diff.CellChanges[0].NewValue
		}
	}
	metadata["version_id"] = version.ID
	metadata["version_number"] = version.VersionNumber
	metadata["before_checksum"] = beforeChecksum
	metadata["after_checksum"] = afterChecksum
	metadata["duration_ms"] = time.Since(history.PreparedAt).Milliseconds()
	return s.recordOperation(model.OperationEvent{
		UserID: history.UserID, SheetID: history.SheetID,
		ResourceType: "sheet", ResourceID: history.SheetID,
		Action: history.Action, Source: history.Source, Summary: history.Summary,
		OldValue: history.OldValue, NewValue: history.NewValue, Metadata: metadata,
	})
}

func (s *SheetHistoryService) captureSnapshot(capture model.SheetVersionCapture, raw json.RawMessage) (*model.SheetVersion, bool, error) {
	normalized, _, checksum, err := normalizeSheetVersionSnapshot(raw)
	if err != nil {
		return nil, false, err
	}
	return s.historyRepo.SaveSheetVersion(capture, normalized, checksum, sheetVersionCoalesceWindow)
}

func (s *SheetHistoryService) CreateCheckpoint(userID, sheetID int64, summary string) (*model.SheetVersion, error) {
	canManage, err := s.canManageSheetHistory(userID, sheetID)
	if err != nil {
		return nil, err
	}
	if !canManage {
		return nil, ErrSheetHistoryDetailsDenied
	}
	snapshot, err := s.historyRepo.LoadSheetSnapshot(sheetID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(summary) == "" {
		summary = "手动保存检查点"
	}
	version, _, err := s.captureSnapshot(model.SheetVersionCapture{
		UserID: userID, SheetID: sheetID, Source: "checkpoint",
		Summary: summary, Force: true,
	}, snapshot)
	if err != nil {
		return nil, err
	}
	version.CanViewDetails = true
	version.CanRestore = true
	if err := s.recordOperation(model.OperationEvent{
		UserID: userID, SheetID: sheetID, ResourceType: "sheet", ResourceID: sheetID,
		Action: "sheet.version.checkpoint", Source: "web", Summary: summary,
		Metadata: map[string]any{"version_id": version.ID, "version_number": version.VersionNumber},
	}); err != nil {
		return nil, err
	}
	return version, nil
}

func (s *SheetHistoryService) ListVersions(userID, sheetID int64, page, size int) ([]model.SheetVersion, int64, error) {
	canView, canManage, err := s.sheetHistoryAccess(userID, sheetID)
	if err != nil {
		return nil, 0, err
	}
	if !canView {
		return nil, 0, ErrSheetPermissionDenied
	}
	page, size = normalizeHistoryPage(page, size, 50)
	versions, total, err := s.historyRepo.ListSheetVersions(sheetID, page, size)
	if err != nil {
		return nil, 0, err
	}
	for index := range versions {
		versions[index].CanViewDetails = canManage
		versions[index].CanRestore = canManage
		if !canManage {
			versions[index].Checksum = ""
		}
	}
	return versions, total, nil
}

func (s *SheetHistoryService) VersionDiff(userID, sheetID, versionID int64) (*model.SheetVersionDiff, error) {
	canManage, err := s.canManageSheetHistory(userID, sheetID)
	if err != nil {
		return nil, err
	}
	if !canManage {
		return nil, ErrSheetHistoryDetailsDenied
	}
	version, err := s.historyRepo.GetSheetVersion(sheetID, versionID)
	if err != nil {
		return nil, err
	}
	_, versionSnapshot, _, err := normalizeSheetVersionSnapshot(version.Snapshot)
	if err != nil {
		return nil, err
	}
	currentRaw, err := s.historyRepo.LoadSheetSnapshot(sheetID)
	if err != nil {
		return nil, err
	}
	_, currentSnapshot, _, err := normalizeSheetVersionSnapshot(currentRaw)
	if err != nil {
		return nil, err
	}
	version.CanViewDetails = true
	version.CanRestore = true
	version.Snapshot = nil
	diff := buildSheetVersionDiff(versionSnapshot, currentSnapshot, sheetVersionDiffCellLimit)
	diff.Version = *version
	return diff, nil
}

func (s *SheetHistoryService) RestoreVersion(userID, sheetID, versionID int64, reason string) (*model.SheetVersion, error) {
	canManage, err := s.canManageSheetHistory(userID, sheetID)
	if err != nil {
		return nil, err
	}
	if !canManage {
		return nil, ErrSheetVersionRestoreDenied
	}
	targetVersion, err := s.historyRepo.GetSheetVersion(sheetID, versionID)
	if err != nil {
		return nil, err
	}
	normalized, targetSnapshot, _, err := normalizeSheetVersionSnapshot(targetVersion.Snapshot)
	if err != nil {
		return nil, err
	}
	currentSheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	if err := applySheetLifecycleState(currentSheet); err != nil {
		return nil, err
	}
	if err := s.ensureRestoreAllowed(userID, currentSheet, targetSnapshot.Sheet.Config); err != nil {
		return nil, err
	}
	before, err := s.historyRepo.LoadSheetSnapshot(sheetID)
	if err != nil {
		return nil, err
	}
	if _, _, err := s.captureSnapshot(model.SheetVersionCapture{
		UserID: userID, SheetID: sheetID, Source: "checkpoint",
		Summary: "恢复版本前自动保存", Force: true,
	}, before); err != nil {
		return nil, err
	}
	if err := s.historyRepo.RestoreSheetSnapshot(sheetID, userID, targetSnapshot); err != nil {
		return nil, err
	}
	if strings.TrimSpace(reason) == "" {
		reason = fmt.Sprintf("恢复到版本 V%d", targetVersion.VersionNumber)
	}
	version, _, err := s.captureSnapshot(model.SheetVersionCapture{
		UserID: userID, SheetID: sheetID, Source: "restore", Summary: reason,
		Force: true, RestoredFromID: &targetVersion.ID,
	}, normalized)
	if err != nil {
		return nil, err
	}
	version.CanViewDetails = true
	version.CanRestore = true
	version.RestoredFrom = &targetVersion.VersionNumber
	if err := s.recordOperation(model.OperationEvent{
		UserID: userID, SheetID: sheetID, ResourceType: "sheet", ResourceID: sheetID,
		Action: "sheet.version.restore", Source: "restore", Summary: reason,
		Metadata: map[string]any{
			"version_id": version.ID, "version_number": version.VersionNumber,
			"restored_from_id": targetVersion.ID, "restored_from_version": targetVersion.VersionNumber,
		},
	}); err != nil {
		return nil, err
	}
	return version, nil
}

func (s *SheetHistoryService) ensureRestoreAllowed(userID int64, currentSheet *model.Sheet, targetConfig json.RawMessage) error {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if currentSheet.IsLocked && !isAdmin {
		return ErrSheetLocked
	}
	if currentSheet.IsArchived && !isAdmin {
		return ErrSheetArchived
	}
	if isAdmin {
		return nil
	}
	if err := ensureProtectionOwnership(currentSheet.Config, userID, "恢复工作表版本"); err != nil {
		return err
	}
	return ensureProtectionOwnership(targetConfig, userID, "恢复工作表版本")
}

func (s *SheetHistoryService) ListSheetAuditLogs(userID, sheetID int64, filter model.OperationLogFilter) ([]model.OperationLog, int64, error) {
	canView, canManage, err := s.sheetHistoryAccess(userID, sheetID)
	if err != nil {
		return nil, 0, err
	}
	if !canView {
		return nil, 0, ErrSheetPermissionDenied
	}
	filter.SheetID = &sheetID
	filter.Page, filter.PageSize = normalizeHistoryPage(filter.Page, filter.PageSize, 50)
	logs, total, err := s.historyRepo.ListOperationLogs(filter)
	if err != nil {
		return nil, 0, err
	}
	if !canManage {
		for index := range logs {
			logs[index].OldValue = nil
			logs[index].NewValue = nil
			logs[index].Metadata = nil
			logs[index].IPAddress = ""
			logs[index].UserAgent = ""
		}
	}
	return logs, total, nil
}

func (s *SheetHistoryService) ListAllAuditLogs(userID int64, filter model.OperationLogFilter) ([]model.OperationLog, int64, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, 0, err
	}
	if !isAdmin {
		return nil, 0, ErrSheetHistoryDetailsDenied
	}
	filter.Page, filter.PageSize = normalizeHistoryPage(filter.Page, filter.PageSize, 100)
	return s.historyRepo.ListOperationLogs(filter)
}

func (s *SheetHistoryService) recordOperation(event model.OperationEvent) error {
	oldValue, err := marshalOptionalJSON(event.OldValue)
	if err != nil {
		return err
	}
	newValue, err := marshalOptionalJSON(event.NewValue)
	if err != nil {
		return err
	}
	metadata, err := marshalDefaultJSON(event.Metadata, `{}`)
	if err != nil {
		return err
	}
	var userID *int64
	if event.UserID > 0 {
		value := event.UserID
		userID = &value
	}
	var sheetID *int64
	if event.SheetID > 0 {
		value := event.SheetID
		sheetID = &value
	}
	resourceID := event.ResourceID
	if resourceID <= 0 {
		resourceID = event.SheetID
	}
	var resourceIDPtr *int64
	if resourceID > 0 {
		resourceIDPtr = &resourceID
	}
	resourceType := strings.TrimSpace(event.ResourceType)
	if resourceType == "" {
		resourceType = "sheet"
	}
	return s.historyRepo.CreateOperationLog(&model.OperationLog{
		UserID: userID, SheetID: sheetID, ResourceType: resourceType, ResourceID: resourceIDPtr,
		Action: event.Action, Source: normalizeHistorySource(event.Source), Summary: event.Summary,
		OldValue: oldValue, NewValue: newValue, Metadata: metadata,
		RequestID: event.RequestID, IPAddress: event.IPAddress, UserAgent: event.UserAgent,
	})
}

func (s *SheetHistoryService) sheetHistoryAccess(userID, sheetID int64) (bool, bool, error) {
	matrix, err := s.permService.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return false, false, err
	}
	canManage, err := s.canManageSheetHistory(userID, sheetID)
	if err != nil {
		return false, false, err
	}
	return matrix.Sheet.CanView, canManage, nil
}

func (s *SheetHistoryService) canManageSheetHistory(userID, sheetID int64) (bool, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return false, err
	}
	workbook, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
	if err != nil {
		return false, err
	}
	return s.permService.CanManageWorkbook(workbook, userID)
}

func normalizeSheetVersionSnapshot(raw json.RawMessage) (json.RawMessage, *model.SheetVersionSnapshot, string, error) {
	var snapshot model.SheetVersionSnapshot
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&snapshot); err != nil {
		return nil, nil, "", fmt.Errorf("decode sheet version snapshot: %w", err)
	}
	if snapshot.SchemaVersion != 1 {
		return nil, nil, "", fmt.Errorf("unsupported sheet version schema %d", snapshot.SchemaVersion)
	}
	if strings.TrimSpace(snapshot.Sheet.Name) == "" || utf8.RuneCountInString(snapshot.Sheet.Name) > 256 {
		return nil, nil, "", fmt.Errorf("invalid version sheet name")
	}
	metadataFields := []*json.RawMessage{&snapshot.Sheet.Columns, &snapshot.Sheet.Frozen, &snapshot.Sheet.Config}
	for _, field := range metadataFields {
		canonical, _, err := canonicalJSON(*field)
		if err != nil {
			return nil, nil, "", fmt.Errorf("invalid sheet metadata in version: %w", err)
		}
		*field = canonical
	}
	if len(snapshot.Rows) > sheetVersionMaxRows {
		return nil, nil, "", fmt.Errorf("sheet version exceeds %d rows", sheetVersionMaxRows)
	}
	seenRows := make(map[int]struct{}, len(snapshot.Rows))
	for index := range snapshot.Rows {
		row := &snapshot.Rows[index]
		if row.RowIndex < 0 || !json.Valid(row.Data) {
			return nil, nil, "", fmt.Errorf("invalid row in sheet version")
		}
		canonicalRow, rowValue, err := canonicalJSON(row.Data)
		if err != nil {
			return nil, nil, "", fmt.Errorf("invalid row %d in sheet version: %w", row.RowIndex, err)
		}
		if _, ok := rowValue.(map[string]any); !ok {
			return nil, nil, "", fmt.Errorf("row %d in sheet version must be an object", row.RowIndex)
		}
		row.Data = canonicalRow
		if _, exists := seenRows[row.RowIndex]; exists {
			return nil, nil, "", fmt.Errorf("duplicate row %d in sheet version", row.RowIndex)
		}
		seenRows[row.RowIndex] = struct{}{}
	}
	sort.Slice(snapshot.Rows, func(i, j int) bool { return snapshot.Rows[i].RowIndex < snapshot.Rows[j].RowIndex })
	normalized, err := json.Marshal(snapshot)
	if err != nil {
		return nil, nil, "", fmt.Errorf("normalize sheet version snapshot: %w", err)
	}
	digest := sha256.Sum256(normalized)
	return normalized, &snapshot, hex.EncodeToString(digest[:]), nil
}

func canonicalJSON(raw json.RawMessage) (json.RawMessage, any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, nil, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return nil, nil, fmt.Errorf("multiple JSON values")
		}
		return nil, nil, err
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return nil, nil, err
	}
	return canonical, value, nil
}

func sheetSnapshotChecksum(raw json.RawMessage) (string, error) {
	_, _, checksum, err := normalizeSheetVersionSnapshot(raw)
	return checksum, err
}

func buildSheetVersionDiff(version, current *model.SheetVersionSnapshot, limit int) *model.SheetVersionDiff {
	diff := &model.SheetVersionDiff{FieldChanges: make([]model.SheetVersionFieldChange, 0), CellChanges: make([]model.SheetVersionCellChange, 0)}
	fields := []struct {
		name string
		old  any
		new  any
	}{
		{name: "name", old: version.Sheet.Name, new: current.Sheet.Name},
		{name: "sort_order", old: version.Sheet.SortOrder, new: current.Sheet.SortOrder},
		{name: "columns", old: version.Sheet.Columns, new: current.Sheet.Columns},
		{name: "frozen", old: version.Sheet.Frozen, new: current.Sheet.Frozen},
		{name: "config", old: version.Sheet.Config, new: current.Sheet.Config},
	}
	for _, field := range fields {
		oldValue, _ := json.Marshal(field.old)
		newValue, _ := json.Marshal(field.new)
		if jsonValuesEqual(oldValue, newValue) {
			continue
		}
		diff.FieldChanges = append(diff.FieldChanges, model.SheetVersionFieldChange{Field: field.name, OldValue: oldValue, NewValue: newValue})
	}

	oldRows := snapshotRowsByIndex(version.Rows)
	newRows := snapshotRowsByIndex(current.Rows)
	rowIndexes := make([]int, 0, len(oldRows)+len(newRows))
	seen := make(map[int]struct{})
	for row := range oldRows {
		seen[row] = struct{}{}
		rowIndexes = append(rowIndexes, row)
	}
	for row := range newRows {
		if _, exists := seen[row]; !exists {
			rowIndexes = append(rowIndexes, row)
		}
	}
	sort.Ints(rowIndexes)
	for _, rowIndex := range rowIndexes {
		oldRow, oldExists := oldRows[rowIndex]
		newRow, newExists := newRows[rowIndex]
		switch {
		case !oldExists:
			diff.AddedRows++
		case !newExists:
			diff.RemovedRows++
		case jsonValuesEqual(oldRow, newRow):
			continue
		default:
			diff.ModifiedRows++
		}

		oldCells := rawObject(oldRow)
		newCells := rawObject(newRow)
		columns := make([]string, 0, len(oldCells)+len(newCells))
		columnSeen := make(map[string]struct{})
		for column := range oldCells {
			columnSeen[column] = struct{}{}
			columns = append(columns, column)
		}
		for column := range newCells {
			if _, exists := columnSeen[column]; !exists {
				columns = append(columns, column)
			}
		}
		sort.Strings(columns)
		for _, column := range columns {
			oldValue, oldCellExists := oldCells[column]
			newValue, newCellExists := newCells[column]
			if oldCellExists && newCellExists && jsonValuesEqual(oldValue, newValue) {
				continue
			}
			diff.ChangedCells++
			if len(diff.CellChanges) >= limit {
				diff.CellChangesLimited = true
				continue
			}
			kind := "modified"
			if !oldCellExists {
				kind = "added"
			} else if !newCellExists {
				kind = "removed"
			}
			diff.CellChanges = append(diff.CellChanges, model.SheetVersionCellChange{
				Row: rowIndex, Column: column, OldValue: oldValue, NewValue: newValue, Kind: kind,
			})
		}
	}
	return diff
}

func snapshotRowsByIndex(rows []model.SheetVersionRowSnapshot) map[int]json.RawMessage {
	result := make(map[int]json.RawMessage, len(rows))
	for _, row := range rows {
		result[row.RowIndex] = row.Data
	}
	return result
}

func rawObject(raw json.RawMessage) map[string]json.RawMessage {
	result := make(map[string]json.RawMessage)
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &result)
	}
	return result
}

func jsonValuesEqual(left, right json.RawMessage) bool {
	var leftValue any
	var rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return bytes.Equal(left, right)
	}
	return valuesEqual(leftValue, rightValue)
}

func valuesEqual(left, right any) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return bytes.Equal(leftJSON, rightJSON)
}

func normalizeHistorySource(source string) string {
	switch strings.ToLower(strings.TrimSpace(source)) {
	case "ai", "import", "sync", "restore", "checkpoint", "baseline", "system", "automation":
		return strings.ToLower(strings.TrimSpace(source))
	default:
		return "web"
	}
}

func metadataMap(value any) map[string]any {
	if value == nil {
		return make(map[string]any)
	}
	if result, ok := value.(map[string]any); ok {
		copyResult := make(map[string]any, len(result))
		for key, item := range result {
			copyResult[key] = item
		}
		return copyResult
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return make(map[string]any)
	}
	result := make(map[string]any)
	_ = json.Unmarshal(raw, &result)
	return result
}

func marshalOptionalJSON(value any) (json.RawMessage, error) {
	if value == nil {
		return nil, nil
	}
	return json.Marshal(value)
}

func marshalDefaultJSON(value any, fallback string) (json.RawMessage, error) {
	if value == nil {
		return json.RawMessage(fallback), nil
	}
	return json.Marshal(value)
}

func normalizeHistoryPage(page, size, maxSize int) (int, int) {
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
