package service

import (
	"encoding/json"
	"testing"

	"yaerp/internal/model"
)

func TestBuildAIPreviewRowsPrefersSnapshotData(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "name", Name: "姓名", Type: "text"},
		{Key: "score", Name: "分数", Type: "number"},
	}

	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {
					"0": {"v": "姓名"},
					"1": {"v": "分数"}
				},
				"1": {
					"0": {"v": "快照张三"},
					"1": {"v": 99}
				}
			}
		}
	}`)

	rowsTableData, _ := json.Marshal(map[string]any{
		"name":  "数据库张三",
		"score": 60,
	})

	sheet := &model.Sheet{
		Config: config,
	}
	rows := []model.Row{
		{RowIndex: 0, Data: rowsTableData},
	}

	previewRows := buildAIPreviewRows(sheet, columns, rows)
	if len(previewRows) != 1 {
		t.Fatalf("buildAIPreviewRows() returned %d rows, want 1", len(previewRows))
	}
	if got := previewRows[0].Data["name"]; got != "快照张三" {
		t.Fatalf("preview row name = %v, want 快照张三", got)
	}
	if got := previewRows[0].Row; got != 0 {
		t.Fatalf("preview row index = %d, want 0", got)
	}
	if got := previewRows[0].DisplayRow; got != 2 {
		t.Fatalf("preview display row = %d, want 2", got)
	}
}
