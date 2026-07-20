package handler

import (
	"strings"
	"testing"
)

func TestNormalizeFolderName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "trims surrounding whitespace", input: "  采购资料  ", want: "采购资料"},
		{name: "rejects blank name", input: " \t\n ", wantErr: true},
		{name: "accepts 256 unicode characters", input: strings.Repeat("文", 256), want: strings.Repeat("文", 256)},
		{name: "rejects more than 256 unicode characters", input: strings.Repeat("文", 257), wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeFolderName(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("normalizeFolderName() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("normalizeFolderName() = %q, want %q", got, tt.want)
			}
		})
	}
}
