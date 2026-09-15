package service

import (
	"bytes"
	"testing"
	"time"
)

func mailCacheKey(uid uint32, part string) mailAttachmentCacheKey {
	return mailAttachmentCacheKey{userID: 7, folder: "INBOX", uid: uid, partID: part}
}

func mailCacheEntry(data string) mailAttachmentCacheEntry {
	return mailAttachmentCacheEntry{filename: "a.txt", contentType: "text/plain", data: []byte(data)}
}

func TestMailAttachmentCacheRoundTrip(t *testing.T) {
	cache := newMailAttachmentCache()
	if _, ok := cache.get(mailCacheKey(1, "2")); ok {
		t.Fatal("empty cache returned a hit")
	}
	cache.put(mailCacheKey(1, "2"), mailCacheEntry("body"))
	entry, ok := cache.get(mailCacheKey(1, "2"))
	if !ok {
		t.Fatal("expected a cache hit")
	}
	if entry.filename != "a.txt" || string(entry.data) != "body" {
		t.Fatalf("unexpected entry: %+v", entry)
	}
	if cache.size() != 1 || cache.byteSize() != 4 {
		t.Fatalf("unexpected cache accounting: size=%d bytes=%d", cache.size(), cache.byteSize())
	}
}

func TestMailAttachmentCacheKeysAreIsolated(t *testing.T) {
	cache := newMailAttachmentCache()
	cache.put(mailAttachmentCacheKey{userID: 7, folder: "INBOX", uid: 1, partID: "2"}, mailCacheEntry("inbox"))
	for _, key := range []mailAttachmentCacheKey{
		{userID: 8, folder: "INBOX", uid: 1, partID: "2"},
		{userID: 7, folder: "Archive", uid: 1, partID: "2"},
		{userID: 7, folder: "INBOX", uid: 2, partID: "2"},
		{userID: 7, folder: "INBOX", uid: 1, partID: "3"},
	} {
		if _, ok := cache.get(key); ok {
			t.Fatalf("unexpected cross-key hit for %+v", key)
		}
	}
}

func TestMailAttachmentCacheInvalidateByMessage(t *testing.T) {
	cache := newMailAttachmentCache()
	cache.put(mailCacheKey(1, "2"), mailCacheEntry("one"))
	cache.put(mailCacheKey(1, "3"), mailCacheEntry("two"))
	cache.put(mailCacheKey(2, "2"), mailCacheEntry("other-message"))

	cache.invalidate(7, "INBOX", 1)
	if _, ok := cache.get(mailCacheKey(1, "2")); ok {
		t.Fatal("invalidated part is still cached")
	}
	if _, ok := cache.get(mailCacheKey(1, "3")); ok {
		t.Fatal("invalidated part is still cached")
	}
	if _, ok := cache.get(mailCacheKey(2, "2")); !ok {
		t.Fatal("another message was evicted")
	}
}

func TestMailAttachmentCacheInvalidateEveryFolder(t *testing.T) {
	cache := newMailAttachmentCache()
	cache.put(mailAttachmentCacheKey{userID: 7, folder: "INBOX", uid: 1, partID: "2"}, mailCacheEntry("one"))
	cache.put(mailAttachmentCacheKey{userID: 7, folder: "Archive", uid: 1, partID: "2"}, mailCacheEntry("two"))
	// An empty folder means "wherever the message used to live".
	cache.invalidate(7, "", 1)
	if cache.size() != 0 {
		t.Fatalf("expected every folder to be dropped, got %d entries", cache.size())
	}
}

func TestMailAttachmentCacheExpiresAfterTTL(t *testing.T) {
	cache := newMailAttachmentCache()
	now := time.Now()
	cache.now = func() time.Time { return now }
	cache.put(mailCacheKey(1, "2"), mailCacheEntry("body"))

	now = now.Add(mailAttachmentCacheTTL - time.Second)
	if _, ok := cache.get(mailCacheKey(1, "2")); !ok {
		t.Fatal("entry expired too early")
	}
	now = now.Add(2 * time.Second)
	if _, ok := cache.get(mailCacheKey(1, "2")); ok {
		t.Fatal("entry survived its TTL")
	}
	if cache.size() != 0 || cache.byteSize() != 0 {
		t.Fatalf("expired entry was not released: size=%d bytes=%d", cache.size(), cache.byteSize())
	}
}

func TestMailAttachmentCacheEvictsLeastRecentlyUsed(t *testing.T) {
	cache := newMailAttachmentCache()
	chunk := bytes.Repeat([]byte("x"), 1<<20) // 1 MiB
	entries := mailAttachmentCacheMaxBytes / len(chunk)
	for i := 0; i < entries; i++ {
		cache.put(mailCacheKey(uint32(i), "1"), mailAttachmentCacheEntry{data: chunk})
	}
	if cache.byteSize() != mailAttachmentCacheMaxBytes {
		t.Fatalf("unexpected byte usage: %d", cache.byteSize())
	}
	// Touch the oldest entry so the second oldest becomes the eviction victim.
	if _, ok := cache.get(mailCacheKey(0, "1")); !ok {
		t.Fatal("expected the first entry to still be cached")
	}
	cache.put(mailCacheKey(uint32(entries), "1"), mailAttachmentCacheEntry{data: chunk})

	if _, ok := cache.get(mailCacheKey(0, "1")); !ok {
		t.Fatal("recently used entry was evicted")
	}
	if _, ok := cache.get(mailCacheKey(1, "1")); ok {
		t.Fatal("least recently used entry was kept")
	}
	if cache.byteSize() > mailAttachmentCacheMaxBytes {
		t.Fatalf("cache exceeded its budget: %d", cache.byteSize())
	}
}

func TestMailAttachmentCacheSkipsOversizedAndEmptyEntries(t *testing.T) {
	cache := newMailAttachmentCache()
	cache.put(mailCacheKey(1, "2"), mailAttachmentCacheEntry{data: make([]byte, mailAttachmentCacheMaxEntry+1)})
	cache.put(mailCacheKey(1, "3"), mailAttachmentCacheEntry{data: []byte{}})
	if cache.size() != 0 || cache.byteSize() != 0 {
		t.Fatalf("oversized or empty entry was stored: size=%d bytes=%d", cache.size(), cache.byteSize())
	}
}

func TestMailAttachmentCacheReplacesExistingKey(t *testing.T) {
	cache := newMailAttachmentCache()
	cache.put(mailCacheKey(1, "2"), mailCacheEntry("first"))
	cache.put(mailCacheKey(1, "2"), mailCacheEntry("second-value"))
	entry, ok := cache.get(mailCacheKey(1, "2"))
	if !ok || string(entry.data) != "second-value" {
		t.Fatalf("unexpected entry after replace: %+v ok=%v", entry, ok)
	}
	if cache.size() != 1 || cache.byteSize() != len("second-value") {
		t.Fatalf("replacement leaked bytes: size=%d bytes=%d", cache.size(), cache.byteSize())
	}
}

func TestMailServiceAttachmentCacheIsLazy(t *testing.T) {
	var service MailService
	if service.mailAttachmentCache() == nil {
		t.Fatal("expected a cache instance")
	}
	if service.mailAttachmentCache() != service.mailAttachmentCache() {
		t.Fatal("cache must be created once per service")
	}
}
