package service

import (
	"fmt"
)

// toolListSheetVersions exposes the sheet version history to the agent so it can
// answer "what happened / when was it changed" and pick a recovery target.
func (s *AIService) toolListSheetVersions(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.historyService == nil {
		return nil, fmt.Errorf("版本历史服务不可用")
	}
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}

	page := 1
	if value, err := int64Arg(args, "page"); err == nil && value > 0 {
		page = int(value)
	}
	size := 20
	if value, err := int64Arg(args, "size"); err == nil && value > 0 {
		size = int(value)
	}
	if size > 200 {
		size = 200
	}

	versions, total, err := s.historyService.ListVersions(userID, sheetID, page, size)
	if err != nil {
		return nil, err
	}

	items := make([]map[string]any, 0, len(versions))
	for _, version := range versions {
		items = append(items, map[string]any{
			"version_id":     version.ID,
			"version_number": version.VersionNumber,
			"source":         version.Source,
			"summary":        version.Summary,
			"created_at":     version.CreatedAt,
			"created_by":     version.CreatedByName,
			"change_count":   version.ChangeCount,
			"can_restore":    version.CanRestore,
		})
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"sheet_id": sheetID,
			"total":    total,
			"page":     page,
			"size":     size,
			"versions": items,
		},
		Summary: fmt.Sprintf("工作表 %d 共有 %d 个历史版本，本页返回 %d 个", sheetID, total, len(items)),
	}, nil
}

// toolRestoreSheetVersion restores a sheet to a historical version. The
// underlying service already snapshots the current state before overwriting, so
// a mistaken restore is itself reversible. It still requires confirm=true so an
// agent cannot silently roll a sheet back.
func (s *AIService) toolRestoreSheetVersion(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.historyService == nil {
		return nil, fmt.Errorf("版本历史服务不可用")
	}
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	versionID, err := int64Arg(args, "version_id")
	if err != nil {
		return nil, err
	}
	if !boolArg(args, "confirm") {
		return nil, fmt.Errorf("恢复会覆盖当前表格内容，必须先向用户说明目标版本并取得确认，然后设置 confirm=true 再次调用")
	}
	reason, _ := stringArgWithDefault(args, "reason", "")

	version, err := s.historyService.RestoreVersion(userID, sheetID, versionID, reason)
	if err != nil {
		return nil, err
	}

	restoredFrom := int64(0)
	if version.RestoredFrom != nil {
		restoredFrom = *version.RestoredFrom
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok":                    true,
			"sheet_id":              sheetID,
			"restored_from_version": restoredFrom,
			"new_version_id":        version.ID,
			"new_version_number":    version.VersionNumber,
			"current_state_backup":  true,
			"history_is_reversible": true,
		},
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  []int64{sheetID},
		ResourcesChanged: true,
		Summary:          fmt.Sprintf("已将工作表 %d 恢复到历史版本 V%d，并自动保留恢复前的状态作为新版本 V%d", sheetID, restoredFrom, version.VersionNumber),
	}, nil
}
