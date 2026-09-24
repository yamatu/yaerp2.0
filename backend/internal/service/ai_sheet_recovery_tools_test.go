package service

import (
	"strings"
	"testing"
)

func TestRecoveryToolsAreRegisteredAndDefined(t *testing.T) {
	service := &AIService{tools: map[string]ToolFunc{}}
	registry := service.buildToolRegistry()
	for _, name := range []string{"list_sheet_versions", "restore_sheet_version"} {
		if _, ok := registry[name]; !ok {
			t.Fatalf("tool %q is not registered", name)
		}
	}

	defined := map[string]bool{}
	for _, definition := range service.buildToolDefinitions() {
		defined[definition.Function.Name] = true
	}
	for _, name := range []string{"list_sheet_versions", "restore_sheet_version"} {
		if !defined[name] {
			t.Fatalf("tool %q has no definition sent to the model", name)
		}
	}
	if !readOnlyAgentTools["list_sheet_versions"] {
		t.Fatal("list_sheet_versions must be read-only")
	}
	if readOnlyAgentTools["restore_sheet_version"] {
		t.Fatal("restore_sheet_version must not be read-only")
	}
}

func TestRestoreSheetVersionRequiresConfirmation(t *testing.T) {
	service := &AIService{historyService: &SheetHistoryService{}}
	_, err := service.toolRestoreSheetVersion(1, map[string]any{
		"sheet_id":   float64(42),
		"version_id": float64(7),
	})
	if err == nil || !strings.Contains(err.Error(), "confirm=true") {
		t.Fatalf("expected a confirmation error, got %v", err)
	}
}
