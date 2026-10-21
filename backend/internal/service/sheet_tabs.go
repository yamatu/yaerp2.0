package service

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"yaerp/internal/model"
)

const sheetTabColorsKey = "sheetTabColors"

var sheetTabColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// UpdateSheetTabsForUser reorders a workbook's sheet tabs and sets their
// colors. Order may list only the sheets the caller sees; they are rearranged
// within the positions they already occupy, so hidden sheets keep their place.
func (s *SheetService) UpdateSheetTabsForUser(userID, workbookID int64, req *model.UpdateSheetTabsRequest) error {
	workbook, err := s.sheetRepo.GetWorkbook(workbookID)
	if err != nil {
		return err
	}
	if err := s.ensureCanAddSheet(userID, workbook); err != nil {
		return err
	}
	sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbookID)
	if err != nil {
		return err
	}
	position := make(map[int64]int, len(sheets))
	for index, sheet := range sheets {
		position[sheet.ID] = index
	}

	if len(req.Order) > 0 {
		seen := make(map[int64]bool, len(req.Order))
		slots := make([]int, 0, len(req.Order))
		for _, id := range req.Order {
			index, ok := position[id]
			if !ok || seen[id] {
				return fmt.Errorf("工作表顺序无效")
			}
			seen[id] = true
			slots = append(slots, index)
		}
		sort.Ints(slots)
		ordered := make([]int64, len(sheets))
		for index, sheet := range sheets {
			ordered[index] = sheet.ID
		}
		for index, id := range req.Order {
			ordered[slots[index]] = id
		}
		if err := s.sheetRepo.UpdateSheetSortOrders(workbookID, ordered); err != nil {
			return err
		}
	}

	if len(req.Colors) > 0 {
		payload := map[string]any{}
		if len(workbook.Metadata) > 0 {
			if err := json.Unmarshal(workbook.Metadata, &payload); err != nil {
				return fmt.Errorf("parse workbook metadata: %w", err)
			}
		}
		colors := map[string]any{}
		if existing, ok := payload[sheetTabColorsKey].(map[string]any); ok {
			colors = existing
		}
		for key, color := range req.Colors {
			id, err := strconv.ParseInt(key, 10, 64)
			if _, ok := position[id]; err != nil || !ok {
				return fmt.Errorf("工作表不存在")
			}
			color = strings.TrimSpace(color)
			if color == "" {
				delete(colors, key)
				continue
			}
			if !sheetTabColorPattern.MatchString(color) {
				return fmt.Errorf("标签颜色格式无效")
			}
			colors[key] = strings.ToLower(color)
		}
		for key := range colors {
			if id, err := strconv.ParseInt(key, 10, 64); err != nil || !hasKey(position, id) {
				delete(colors, key)
			}
		}
		if len(colors) == 0 {
			delete(payload, sheetTabColorsKey)
		} else {
			payload[sheetTabColorsKey] = colors
		}
		metadata, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("marshal workbook metadata: %w", err)
		}
		workbook.Metadata = metadata
		if err := s.sheetRepo.UpdateWorkbook(workbook); err != nil {
			return err
		}
	}

	return s.RecordOperation(model.OperationEvent{
		UserID: userID, ResourceType: "workbook", ResourceID: workbookID,
		Action: "workbook.sheet_tabs", Source: "web", Summary: "调整工作表标签",
		Metadata: map[string]any{"workbook_id": workbookID, "order": req.Order, "colors": req.Colors},
	})
}

func hasKey(values map[int64]int, key int64) bool {
	_, ok := values[key]
	return ok
}
