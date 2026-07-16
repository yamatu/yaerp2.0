package service

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"

	"yaerp/internal/model"
)

func TestNormalizedReplacementImageFilename(t *testing.T) {
	tests := []struct {
		name        string
		candidate   string
		fallback    string
		contentType string
		want        string
	}{
		{name: "preserves jpeg extension", candidate: "photo.jpeg", contentType: "image/jpeg", want: "photo.jpeg"},
		{name: "replaces mismatched extension", candidate: "photo.webp", contentType: "image/png", want: "photo.png"},
		{name: "falls back to original name", fallback: "camera.jpg", contentType: "image/png", want: "camera.png"},
		{name: "strips client path", candidate: `folder\photo.jpg`, contentType: "image/jpeg", want: "photo.jpg"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizedReplacementImageFilename(test.candidate, test.fallback, test.contentType); got != test.want {
				t.Fatalf("normalizedReplacementImageFilename() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestAttachmentAccessURLIncludesContentVersion(t *testing.T) {
	service := &UploadService{fileURLSecret: "test-secret"}
	attachment := &model.Attachment{ID: 42, ContentHash: strings.Repeat("a", 64)}
	url := service.attachmentAccessURL(attachment)
	if !strings.Contains(url, "signature=") {
		t.Fatalf("attachmentAccessURL() missing signature: %s", url)
	}
	if !strings.Contains(url, "&v="+strings.Repeat("a", 16)) {
		t.Fatalf("attachmentAccessURL() missing content version: %s", url)
	}
}

func TestSupportedReplacementImageTypes(t *testing.T) {
	for _, contentType := range []string{"image/jpeg", "image/png", "image/webp", "image/gif"} {
		if !isSupportedReplacementImageType(contentType) {
			t.Fatalf("expected %s to be supported", contentType)
		}
	}
	if isSupportedReplacementImageType("image/svg+xml") {
		t.Fatal("SVG replacement must be rejected because canvas output is rasterized")
	}
}

func TestBuildCompressedThumbnail(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 1200, 600))
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: uint8(x % 255), G: uint8(y % 255), B: 120, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}

	thumbnail, err := buildCompressedThumbnail(encoded.Bytes(), 320)
	if err != nil {
		t.Fatalf("buildCompressedThumbnail() error = %v", err)
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(thumbnail))
	if err != nil {
		t.Fatalf("thumbnail is not JPEG: %v", err)
	}
	if config.Width != 320 || config.Height != 160 {
		t.Fatalf("thumbnail dimensions = %dx%d, want 320x160", config.Width, config.Height)
	}
}

func TestNormalizeThumbnailSize(t *testing.T) {
	tests := map[int]int{0: 160, 200: 320, 500: 640, 900: 960, 5000: 960}
	for input, want := range tests {
		if got := normalizeThumbnailSize(input); got != want {
			t.Fatalf("normalizeThumbnailSize(%d) = %d, want %d", input, got, want)
		}
	}
}
