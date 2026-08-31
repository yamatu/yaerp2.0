package ws

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
)

const (
	hubBroadcastBuffer = 256
	clientSendBuffer   = 64
)

type Message struct {
	Type     string          `json:"type"`
	SheetID  int64           `json:"sheetId,omitempty"`
	Row      int             `json:"row,omitempty"`
	Col      string          `json:"col,omitempty"`
	Value    json.RawMessage `json:"value,omitempty"`
	Changes  json.RawMessage `json:"changes,omitempty"`
	AfterRow int             `json:"afterRow,omitempty"`
	UserID   int64           `json:"userId,omitempty"`
}

type Client struct {
	Hub      *Hub
	UserID   int64
	Username string
	SheetID  int64
	Send     chan []byte

	closeOnce sync.Once
	closed    bool // guarded by Hub.mu
}

// NewClient gives every connection a bounded outbound queue. Keeping this
// constructor in the ws package also makes it harder for handlers to
// accidentally create an unbounded or nil channel.
func NewClient(hub *Hub, userID int64, username string) *Client {
	return &Client{
		Hub:      hub,
		UserID:   userID,
		Username: username,
		Send:     make(chan []byte, clientSendBuffer),
	}
}

type Hub struct {
	clients   map[*Client]bool
	sheets    map[int64]map[*Client]bool // sheetID -> clients
	broadcast chan *BroadcastMsg
	done      chan struct{}
	stopOnce  sync.Once
	mu        sync.RWMutex

	droppedBroadcasts atomic.Uint64
	slowClients       atomic.Uint64
}

type BroadcastMsg struct {
	SheetID int64
	Data    []byte
	Sender  *Client
}

func NewHub() *Hub {
	return &Hub{
		clients:   make(map[*Client]bool),
		sheets:    make(map[int64]map[*Client]bool),
		broadcast: make(chan *BroadcastMsg, hubBroadcastBuffer),
		done:      make(chan struct{}),
	}
}

// Register hands ownership of the client lifecycle to the hub synchronously.
// Synchronous registration closes the race where a connection can disconnect
// before an event-loop registration is processed.
func (h *Hub) Register(client *Client) bool {
	if h == nil || client == nil {
		return false
	}
	if client.Hub == nil {
		client.Hub = h
	}
	if client.Send == nil {
		client.Send = make(chan []byte, clientSendBuffer)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	select {
	case <-h.done:
		return false
	default:
	}
	if client.closed {
		return false
	}
	h.clients[client] = true
	return true
}

// Unregister is safe to call from both read and write pumps. Removing directly
// avoids leaving a pump goroutine blocked on an event channel when the hub is
// shutting down; removeClient is idempotent, so duplicate calls are harmless.
func (h *Hub) Unregister(client *Client) {
	if h == nil || client == nil {
		return
	}
	h.removeClient(client)
}

func (h *Hub) Run() {
	for {
		select {
		case <-h.done:
			h.closeAll()
			return

		case msg := <-h.broadcast:
			h.broadcastMessage(msg)
		}
	}
}

func (h *Hub) removeClient(client *Client) {
	if client == nil {
		return
	}
	h.mu.Lock()
	if _, ok := h.clients[client]; !ok {
		h.mu.Unlock()
		return
	}
	delete(h.clients, client)
	client.closed = true
	for sheetID, clients := range h.sheets {
		delete(clients, client)
		if len(clients) == 0 {
			delete(h.sheets, sheetID)
		}
	}
	client.SheetID = 0
	client.closeSend()
	h.mu.Unlock()
}

func (h *Hub) broadcastMessage(msg *BroadcastMsg) {
	if msg == nil || len(msg.Data) == 0 {
		return
	}

	// Keep the read lock while delivering. removeClient/Close take the write
	// lock before closing a channel, which prevents a concurrent send-on-closed
	// panic. Delivery is non-blocking, so the lock is held only briefly.
	h.mu.RLock()
	slow := make([]*Client, 0)
	if clients, ok := h.sheets[msg.SheetID]; ok {
		for client := range clients {
			if client == msg.Sender {
				continue
			}
			select {
			case client.Send <- msg.Data:
			default:
				slow = append(slow, client)
			}
		}
	}
	h.mu.RUnlock()

	for _, client := range slow {
		// Do not start a goroutine per dropped message. Remove the slow
		// client synchronously; removeClient is idempotent.
		h.slowClients.Add(1)
		h.removeClient(client)
	}
}

func (h *Hub) JoinSheet(client *Client, sheetID int64) {
	if h == nil || client == nil || sheetID <= 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[client]; !ok {
		return
	}

	// Leave previous sheet.
	if client.SheetID > 0 {
		if clients, ok := h.sheets[client.SheetID]; ok {
			delete(clients, client)
			if len(clients) == 0 {
				delete(h.sheets, client.SheetID)
			}
		}
	}

	client.SheetID = sheetID
	if _, ok := h.sheets[sheetID]; !ok {
		h.sheets[sheetID] = make(map[*Client]bool)
	}
	h.sheets[sheetID][client] = true

	log.Printf("User %s joined sheet %d", client.Username, sheetID)
}

// BroadcastToSheet never blocks a request goroutine when the hub queue is
// full. The caller can use the return value to record a dropped update.
func (h *Hub) BroadcastToSheet(sheetID int64, data []byte, sender *Client) bool {
	if h == nil || sheetID <= 0 || len(data) == 0 {
		return false
	}
	// Make ownership explicit: callers frequently reuse a JSON buffer after
	// enqueueing it.
	payload := append([]byte(nil), data...)
	msg := &BroadcastMsg{SheetID: sheetID, Data: payload, Sender: sender}
	select {
	case <-h.done:
		return false
	case h.broadcast <- msg:
		return true
	default:
		h.droppedBroadcasts.Add(1)
		return false
	}
}

func (h *Hub) ClientCount() int {
	if h == nil {
		return 0
	}
	h.mu.RLock()
	count := len(h.clients)
	h.mu.RUnlock()
	return count
}

func (h *Hub) CurrentSheetID(client *Client) int64 {
	if h == nil || client == nil {
		return 0
	}
	h.mu.RLock()
	sheetID := client.SheetID
	h.mu.RUnlock()
	return sheetID
}

func (h *Hub) DroppedBroadcastCount() uint64 {
	if h == nil {
		return 0
	}
	return h.droppedBroadcasts.Load()
}

func (h *Hub) SlowClientCount() uint64 {
	if h == nil {
		return 0
	}
	return h.slowClients.Load()
}

func (h *Hub) Close() {
	if h == nil {
		return
	}
	h.stopOnce.Do(func() {
		close(h.done)
		h.closeAll()
	})
}

func (h *Hub) closeAll() {
	h.mu.Lock()
	for client := range h.clients {
		client.closed = true
		client.SheetID = 0
		client.closeSend()
	}
	h.clients = make(map[*Client]bool)
	h.sheets = make(map[int64]map[*Client]bool)
	h.mu.Unlock()
}

func (c *Client) closeSend() {
	if c == nil || c.Send == nil {
		return
	}
	c.closeOnce.Do(func() { close(c.Send) })
}
