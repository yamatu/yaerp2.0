package service

import "testing"

func TestParsePDFExportOptionsDefaultsToPortrait(t *testing.T) {
	options, err := ParsePDFExportOptions("", "", "")
	if err != nil {
		t.Fatalf("ParsePDFExportOptions returned an error: %v", err)
	}
	if options.PaperSize != "a4" {
		t.Fatalf("expected default paper size a4, got %q", options.PaperSize)
	}
	if options.Orientation != "portrait" {
		t.Fatalf("expected default portrait orientation, got %q", options.Orientation)
	}
	if !options.FitToWidth {
		t.Fatal("expected fit-to-width to be enabled by default")
	}
}
