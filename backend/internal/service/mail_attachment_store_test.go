package service

import (
	"errors"
	"testing"

	"yaerp/internal/model"
)

type fakeMailAttachmentStore struct {
	attachment  *model.Attachment
	url         string
	err         error
	filename    string
	contentType string
	size        int
	userID      int64
	calls       int
}

func (store *fakeMailAttachmentStore) StoreOrReuseFile(filename, contentType string, data []byte, userID int64) (*model.Attachment, string, error) {
	store.calls++
	store.filename = filename
	store.contentType = contentType
	store.size = len(data)
	store.userID = userID
	return store.attachment, store.url, store.err
}

func cachedMailService(uid uint32, partID, data string) *MailService {
	service := NewMailService(nil, nil, "test-secret")
	service.mailAttachmentCache().put(
		mailAttachmentCacheKey{userID: 7, folder: "INBOX", uid: uid, partID: partID},
		mailAttachmentCacheEntry{filename: "report.pdf", contentType: "application/pdf", data: []byte(data)},
	)
	return service
}

func TestEnsureAttachmentFileRequiresStore(t *testing.T) {
	service := cachedMailService(1, "2", "pdf-bytes")
	if _, _, err := service.EnsureAttachmentFile(7, "INBOX", 1, "2"); !errors.Is(err, ErrMailAttachmentStoreUnavailable) {
		t.Fatalf("expected ErrMailAttachmentStoreUnavailable, got %v", err)
	}
}

func TestEnsureAttachmentFileRejectsEmptyPart(t *testing.T) {
	store := &fakeMailAttachmentStore{}
	service := cachedMailService(1, "2", "pdf-bytes")
	service.SetAttachmentStore(store)
	if _, _, err := service.EnsureAttachmentFile(7, "INBOX", 1, "  "); err == nil {
		t.Fatal("expected an error for an empty part id")
	}
	if store.calls != 0 {
		t.Fatalf("store must not be called, got %d calls", store.calls)
	}
}

func TestEnsureAttachmentFileStoresCachedBytes(t *testing.T) {
	store := &fakeMailAttachmentStore{
		attachment: &model.Attachment{ID: 42, Filename: "report.pdf", MimeType: "application/pdf", Size: 9},
		url:        "/api/files/42/content?signature=abc",
	}
	// The bytes are already memoized, so no IMAP or database access is needed.
	service := cachedMailService(1, "2", "pdf-bytes")
	service.SetAttachmentStore(store)

	attachment, url, err := service.EnsureAttachmentFile(7, "INBOX", 1, "2")
	if err != nil {
		t.Fatal(err)
	}
	if attachment == nil || attachment.ID != 42 {
		t.Fatalf("unexpected attachment: %+v", attachment)
	}
	if url != "/api/files/42/content?signature=abc" {
		t.Fatalf("unexpected url: %q", url)
	}
	if store.calls != 1 {
		t.Fatalf("expected one store call, got %d", store.calls)
	}
	if store.filename != "report.pdf" || store.contentType != "application/pdf" {
		t.Fatalf("store received %q / %q", store.filename, store.contentType)
	}
	if store.size != len("pdf-bytes") {
		t.Fatalf("store received %d bytes", store.size)
	}
	if store.userID != 7 {
		t.Fatalf("store received user %d", store.userID)
	}
}

func TestEnsureAttachmentFileDefaultsContentType(t *testing.T) {
	service := NewMailService(nil, nil, "test-secret")
	service.mailAttachmentCache().put(
		mailAttachmentCacheKey{userID: 7, folder: "INBOX", uid: 3, partID: "9"},
		mailAttachmentCacheEntry{filename: "blob.bin", data: []byte("raw")},
	)
	store := &fakeMailAttachmentStore{
		attachment: &model.Attachment{ID: 1, Filename: "blob.bin"},
		url:        "/api/files/1/content?signature=abc",
	}
	service.SetAttachmentStore(store)

	if _, _, err := service.EnsureAttachmentFile(7, "INBOX", 3, "9"); err != nil {
		t.Fatal(err)
	}
	if store.contentType != "application/octet-stream" {
		t.Fatalf("unexpected content type: %q", store.contentType)
	}
}

func TestEnsureAttachmentFilePropagatesStoreFailure(t *testing.T) {
	store := &fakeMailAttachmentStore{err: errors.New("minio down")}
	service := cachedMailService(1, "2", "pdf-bytes")
	service.SetAttachmentStore(store)

	if _, _, err := service.EnsureAttachmentFile(7, "INBOX", 1, "2"); err == nil {
		t.Fatal("expected the storage error to propagate")
	}
}

func TestEnsureAttachmentFileRejectsEmptyStoreResult(t *testing.T) {
	store := &fakeMailAttachmentStore{}
	service := cachedMailService(1, "2", "pdf-bytes")
	service.SetAttachmentStore(store)

	if _, _, err := service.EnsureAttachmentFile(7, "INBOX", 1, "2"); err == nil {
		t.Fatal("expected an error when the store returns nothing")
	}
}
