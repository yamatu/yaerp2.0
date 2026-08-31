package handler

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

type recordedSheetBroadcast struct {
	sheetID         int64
	excludeClientID string
	payload         []byte
}

type recordingSheetBroadcaster struct {
	broadcasts []recordedSheetBroadcast
}

func (b *recordingSheetBroadcaster) BroadcastToSheetExceptClientID(sheetID int64, payload []byte, excludeClientID string) {
	b.broadcasts = append(b.broadcasts, recordedSheetBroadcast{
		sheetID:         sheetID,
		excludeClientID: excludeClientID,
		payload:         payload,
	})
}

func (b *recordingSheetBroadcaster) BroadcastToSheetByUser(int64, string, func(int64) []byte) {}

func TestBroadcastSheetSyncDeduplicatesSheets(t *testing.T) {
	gin.SetMode(gin.TestMode)
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest("POST", "/", nil)
	context.Request.Header.Set("X-Client-Id", "client-7")
	context.Set("user_id", int64(15))

	broadcaster := &recordingSheetBroadcaster{}
	handler := &SheetHandler{broadcaster: broadcaster}
	handler.broadcastSheetSync(context, 42, 0, 42, -1, 43)

	if len(broadcaster.broadcasts) != 2 {
		t.Fatalf("expected 2 broadcasts, got %d", len(broadcaster.broadcasts))
	}

	for index, expectedSheetID := range []int64{42, 43} {
		broadcast := broadcaster.broadcasts[index]
		if broadcast.sheetID != expectedSheetID {
			t.Fatalf("expected sheet %d, got %d", expectedSheetID, broadcast.sheetID)
		}
		if broadcast.excludeClientID != "client-7" {
			t.Fatalf("expected client exclusion client-7, got %q", broadcast.excludeClientID)
		}

		var payload struct {
			Type    string `json:"type"`
			SheetID int64  `json:"sheetId"`
			UserID  int64  `json:"userId"`
		}
		if err := json.Unmarshal(broadcast.payload, &payload); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		if payload.Type != "sheet_sync" || payload.SheetID != expectedSheetID || payload.UserID != 15 {
			t.Fatalf("unexpected payload: %+v", payload)
		}
	}
}
