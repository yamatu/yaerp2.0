package service

import (
	"archive/tar"
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestBoundedBufferRejectsOversizedWrites(t *testing.T) {
	var buffer boundedBuffer
	buffer.max = 4
	if _, err := buffer.Write([]byte("1234")); err != nil {
		t.Fatalf("first write failed: %v", err)
	}
	if _, err := buffer.Write([]byte("5")); !errors.Is(err, ErrBackupTooLarge) {
		t.Fatalf("oversized write error = %v, want errBackupTooLarge", err)
	}
	if !buffer.limited || buffer.Len() != 4 {
		t.Fatalf("buffer state after limit: limited=%v len=%d", buffer.limited, buffer.Len())
	}
}

func TestAddReaderToTarStreamsExactSize(t *testing.T) {
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	if err := addReaderToTar(writer, "payload.bin", bytes.NewReader([]byte("hello")), 5); err != nil {
		t.Fatalf("addReaderToTar failed: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	reader := tar.NewReader(bytes.NewReader(archive.Bytes()))
	header, err := reader.Next()
	if err != nil {
		t.Fatalf("read tar header: %v", err)
	}
	if header.Name != "payload.bin" || header.Size != 5 {
		t.Fatalf("header = %#v", header)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read tar payload: %v", err)
	}
	if string(data) != "hello" {
		t.Fatalf("payload = %q", data)
	}
}
