package service

import (
	"encoding/json"
	"testing"

	"yaerp/internal/model"
)

func TestTradeERPCellSyncSkipsApprovalInterception(t *testing.T) {
	service := &AutomationService{}
	changes := []model.CellUpdate{{SheetID: 8, Row: 0, Col: "stage", Value: json.RawMessage(`"质检"`)}}
	result, err := service.InterceptCellChanges(3, changes, "trade_erp")
	if err != nil {
		t.Fatalf("trade ERP sync should bypass approval interception: %v", err)
	}
	if result == nil || len(result.AppliedChanges) != 1 || len(result.PendingStates) != 0 {
		t.Fatalf("unexpected trade ERP interception result: %#v", result)
	}
}
