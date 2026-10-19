package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestChunkTranslationTextSplitsOnLines(t *testing.T) {
	chunks := chunkTranslationText("aaaa\r\nbbbb\ncccc\n\ndddd", 9)
	if len(chunks) != 3 || chunks[0] != "aaaa\nbbbb" || chunks[1] != "cccc" || chunks[2] != "dddd" {
		t.Fatalf("unexpected chunks: %#v", chunks)
	}
	if got := chunkTranslationText(" \n ", 10); got != nil {
		t.Fatalf("blank text should produce no chunks: %#v", got)
	}
}

func TestNormalizeTranslationEndpoint(t *testing.T) {
	for _, input := range []string{"https://x.test/v1", "https://x.test/v1/", " https://x.test/v1/chat/completions ", "https://x.test/v1/models"} {
		if got := normalizeTranslationEndpoint(input); got != "https://x.test/v1" {
			t.Fatalf("normalize(%q) = %q", input, got)
		}
	}
}

func TestTranslationEngineDetectsModelAndAlignsChunks(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"data":[{"id":"general-chat"},{"id":"Index-Translate-35B"}]}`))
		case "/v1/chat/completions":
			atomic.AddInt32(&calls, 1)
			var body struct {
				Model    string        `json:"model"`
				Messages []ChatMessage `json:"messages"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			prompt := body.Messages[0].Content
			if body.Model != "Index-Translate-35B" || !strings.Contains(prompt, "into Spanish") {
				http.Error(w, "bad request", http.StatusBadRequest)
				return
			}
			source := prompt[strings.Index(prompt, "\n\n")+2:]
			reply, _ := json.Marshal(map[string]any{
				"model":   body.Model,
				"choices": []any{map[string]any{"message": map[string]any{"content": strings.ToUpper(source)}}},
			})
			_, _ = w.Write(reply)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	svc := &AIService{}
	modelName, err := svc.detectTranslationModel(server.URL + "/v1")
	if err != nil || modelName != "Index-Translate-35B" {
		t.Fatalf("detect model = %q, %v", modelName, err)
	}

	config := TranslationEngineConfig{Enabled: true, Endpoint: server.URL + "/v1", Model: modelName}
	source := strings.Repeat("hello world\n", translationChunkChars/12+5) + "\nlast line"
	result, err := svc.translateWithEngine(config, source, "es", true)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if atomic.LoadInt32(&calls) < 2 {
		t.Fatalf("expected long text to be chunked, got %d calls", calls)
	}
	sourceSegments := splitTranslationSegments(source)
	if len(result.Segments) != len(sourceSegments) {
		t.Fatalf("segments = %d, want %d", len(result.Segments), len(sourceSegments))
	}
	last := result.Segments[len(result.Segments)-1]
	if last.Source != "last line" || last.Translation != "LAST LINE" || result.AssistantName != translationEngineName {
		t.Fatalf("unexpected result: %#v", last)
	}
}
