package service

import (
	"container/list"
	"sync"
	"time"
)

// Mail attachments are fetched over IMAP, which downloads the whole message and
// parses every part: opening the same preview twice used to pay that cost twice.
// The cache below keeps recently read parts in memory for a short time so the
// preview, the download button and repeated range requests stay instant.
const (
	mailAttachmentCacheTTL      = 10 * time.Minute
	mailAttachmentCacheMaxBytes = 64 << 20
	mailAttachmentCacheMaxEntry = 32 << 20
)

type mailAttachmentCacheKey struct {
	userID int64
	folder string
	uid    uint32
	partID string
}

type mailAttachmentCacheEntry struct {
	filename    string
	contentType string
	data        []byte
	storedAt    time.Time
}

type mailAttachmentCacheItem struct {
	key   mailAttachmentCacheKey
	entry mailAttachmentCacheEntry
}

// mailAttachmentCache is a small byte-bounded LRU with a TTL. It is safe for
// concurrent use and created lazily so a zero-value service still works.
type mailAttachmentCache struct {
	mu      sync.Mutex
	order   *list.List
	entries map[mailAttachmentCacheKey]*list.Element
	bytes   int
	now     func() time.Time
}

func newMailAttachmentCache() *mailAttachmentCache {
	return &mailAttachmentCache{
		order:   list.New(),
		entries: make(map[mailAttachmentCacheKey]*list.Element),
		now:     time.Now,
	}
}

// get returns a cached attachment and marks it as recently used. Entries larger
// than the per-entry limit are never stored, and expired entries are dropped on
// the way out.
func (cache *mailAttachmentCache) get(key mailAttachmentCacheKey) (mailAttachmentCacheEntry, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	element, ok := cache.entries[key]
	if !ok {
		return mailAttachmentCacheEntry{}, false
	}
	item := element.Value.(*mailAttachmentCacheItem)
	if cache.now().Sub(item.entry.storedAt) > mailAttachmentCacheTTL {
		cache.removeElement(element)
		return mailAttachmentCacheEntry{}, false
	}
	cache.order.MoveToFront(element)
	return item.entry, true
}

// put stores an attachment, evicting the least recently used entries until the
// byte budget fits again.
func (cache *mailAttachmentCache) put(key mailAttachmentCacheKey, entry mailAttachmentCacheEntry) {
	if len(entry.data) == 0 || len(entry.data) > mailAttachmentCacheMaxEntry {
		return
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if existing, ok := cache.entries[key]; ok {
		cache.removeElement(existing)
	}
	entry.storedAt = cache.now()
	element := cache.order.PushFront(&mailAttachmentCacheItem{key: key, entry: entry})
	cache.entries[key] = element
	cache.bytes += len(entry.data)
	for cache.bytes > mailAttachmentCacheMaxBytes {
		oldest := cache.order.Back()
		if oldest == nil {
			break
		}
		cache.removeElement(oldest)
	}
}

// invalidate drops every part of one message, used after a move or delete so a
// stale body cannot be served from memory.
func (cache *mailAttachmentCache) invalidate(userID int64, folder string, uid uint32) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	for key, element := range cache.entries {
		if key.userID == userID && key.uid == uid && (folder == "" || key.folder == folder) {
			cache.removeElement(element)
		}
	}
}

func (cache *mailAttachmentCache) removeElement(element *list.Element) {
	item := element.Value.(*mailAttachmentCacheItem)
	delete(cache.entries, item.key)
	cache.order.Remove(element)
	cache.bytes -= len(item.entry.data)
	if cache.bytes < 0 {
		cache.bytes = 0
	}
}

// size reports the number of cached parts, used by tests and diagnostics.
func (cache *mailAttachmentCache) size() int {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return len(cache.entries)
}

// byteSize reports how many attachment bytes are held in memory.
func (cache *mailAttachmentCache) byteSize() int {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return cache.bytes
}

func (s *MailService) mailAttachmentCache() *mailAttachmentCache {
	s.attachmentCacheOnce.Do(func() {
		s.attachmentCache = newMailAttachmentCache()
	})
	return s.attachmentCache
}
