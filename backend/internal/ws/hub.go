package ws

import (
	"encoding/json"
	"log"
	"sort"
	"sync"
	"sync/atomic"
)

const (
	hubBroadcastBuffer = 256
	clientSendBuffer   = 64
	maxBroadcastBytes  = 1 << 20
)

type Message struct {
	Type      string          `json:"type"`
	SheetID   int64           `json:"sheetId,omitempty"`
	ChannelID int64           `json:"channelId,omitempty"`
	MessageID int64           `json:"messageId,omitempty"`
	OrderID   int64           `json:"orderId,omitempty"`
	Row       int             `json:"row,omitempty"`
	Col       string          `json:"col,omitempty"`
	Value     json.RawMessage `json:"value,omitempty"`
	Changes   json.RawMessage `json:"changes,omitempty"`
	AfterRow  int             `json:"afterRow,omitempty"`
	UserID    int64           `json:"userId,omitempty"`
	Username  string          `json:"username,omitempty"`
	ClientID  string          `json:"clientId,omitempty"`
	State     string          `json:"state,omitempty"`
	Presence  []PresenceEntry `json:"presence,omitempty"`
}

type PresenceEntry struct {
	UserID   int64  `json:"userId"`
	Username string `json:"username"`
	ClientID string `json:"clientId"`
	State    string `json:"state"`
	Row      *int   `json:"row,omitempty"`
	Col      string `json:"col,omitempty"`
}

type Client struct {
	Hub      *Hub
	UserID   int64
	Username string
	ClientID string
	SheetID  int64
	State    string
	Row      *int
	Col      string
	Send     chan []byte

	closeOnce sync.Once
	closed    bool // guarded by Hub.mu
}

func NewClient(hub *Hub, userID int64, username, clientID string) *Client {
	return &Client{
		Hub:      hub,
		UserID:   userID,
		Username: username,
		ClientID: clientID,
		Send:     make(chan []byte, clientSendBuffer),
	}
}

type Hub struct {
	clients    map[*Client]bool
	sheets     map[int64]map[*Client]bool // sheetID -> clients
	broadcast  chan *BroadcastMsg
	register   chan *Client // retained for compatibility with older callers
	unregister chan *Client // retained for compatibility with older callers
	done       chan struct{}
	stopOnce   sync.Once
	mu         sync.RWMutex

	droppedBroadcasts atomic.Uint64
	slowClients       atomic.Uint64

	presenceMu    sync.Mutex
	presenceCache map[int64]string
}

type BroadcastMsg struct {
	SheetID         int64
	Data            []byte
	Sender          *Client
	ExcludeClientID string
}

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		sheets:     make(map[int64]map[*Client]bool),
		broadcast:  make(chan *BroadcastMsg, hubBroadcastBuffer),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		done:       make(chan struct{}),

		presenceCache: make(map[int64]string),
	}
}

// Register is synchronous so a connection cannot disconnect before its
// registration event is processed by the hub loop.
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

// Unregister is idempotent and never blocks a read/write pump during shutdown.
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
		case client := <-h.register:
			h.Register(client)
		case client := <-h.unregister:
			h.removeClient(client)
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
	oldSheetID := client.SheetID
	delete(h.clients, client)
	client.closed = true
	if oldSheetID > 0 {
		if clients, ok := h.sheets[oldSheetID]; ok {
			delete(clients, client)
			if len(clients) == 0 {
				delete(h.sheets, oldSheetID)
			}
		}
	}
	client.SheetID = 0
	client.closeSend()
	h.mu.Unlock()

	if oldSheetID > 0 {
		h.publishPresence(oldSheetID)
	}
}

func (h *Hub) JoinSheet(client *Client, sheetID int64) {
	if h == nil || client == nil || sheetID <= 0 {
		return
	}
	h.mu.Lock()
	if _, ok := h.clients[client]; !ok || client.closed {
		h.mu.Unlock()
		return
	}
	oldSheetID := client.SheetID
	if oldSheetID > 0 {
		if clients, ok := h.sheets[oldSheetID]; ok {
			delete(clients, client)
			if len(clients) == 0 {
				delete(h.sheets, oldSheetID)
			}
		}
	}
	client.SheetID = sheetID
	client.State = "viewing"
	client.Row = nil
	client.Col = ""
	if _, ok := h.sheets[sheetID]; !ok {
		h.sheets[sheetID] = make(map[*Client]bool)
	}
	h.sheets[sheetID][client] = true
	h.mu.Unlock()

	log.Printf("User %s joined sheet %d", client.Username, sheetID)
	if oldSheetID > 0 && oldSheetID != sheetID {
		h.publishPresence(oldSheetID)
	}
	h.publishPresence(sheetID)
}

func (h *Hub) LeaveSheet(client *Client) {
	if h == nil || client == nil {
		return
	}
	h.mu.Lock()
	oldSheetID := client.SheetID
	if oldSheetID > 0 {
		if clients, ok := h.sheets[oldSheetID]; ok {
			delete(clients, client)
			if len(clients) == 0 {
				delete(h.sheets, oldSheetID)
			}
		}
	}
	client.SheetID = 0
	client.State = "viewing"
	client.Row = nil
	client.Col = ""
	h.mu.Unlock()
	if oldSheetID > 0 {
		h.publishPresence(oldSheetID)
	}
}

func (h *Hub) UpdatePresence(client *Client, state string, row *int, col string) {
	if h == nil || client == nil {
		return
	}
	h.mu.Lock()
	sheetID := client.SheetID
	rowChanged := (client.Row == nil) != (row == nil) || (client.Row != nil && row != nil && *client.Row != *row)
	changed := client.State != state || rowChanged || client.Col != col
	client.State = state
	client.Row = row
	client.Col = col
	h.mu.Unlock()
	if sheetID > 0 && changed {
		h.publishPresence(sheetID)
	}
}

func (h *Hub) publishPresence(sheetID int64) {
	h.mu.RLock()
	clients := h.sheets[sheetID]
	if len(clients) == 0 {
		h.mu.RUnlock()
		h.presenceMu.Lock()
		delete(h.presenceCache, sheetID)
		h.presenceMu.Unlock()
		return
	}
	entries := make([]PresenceEntry, 0, len(clients))
	for client := range clients {
		entry := PresenceEntry{
			UserID:   client.UserID,
			Username: client.Username,
			ClientID: client.ClientID,
			State:    client.State,
			Col:      client.Col,
		}
		if client.Row != nil {
			row := *client.Row
			entry.Row = &row
		}
		entries = append(entries, entry)
	}
	// Map iteration order is random; sort so identical presence sets always
	// produce the same signature for the dedupe check below.
	sort.Slice(entries, func(i, j int) bool { return entries[i].ClientID < entries[j].ClientID })
	data, err := json.Marshal(Message{Type: "sheet_presence", SheetID: sheetID, Presence: entries})
	if err != nil {
		h.mu.RUnlock()
		return
	}
	// Skip broadcasting identical presence snapshots. Cell selection broadcasts
	// fire very frequently; without this dedupe every client re-renders on each
	// duplicate update.
	signature := string(data)
	h.presenceMu.Lock()
	if h.presenceCache == nil {
		h.presenceCache = make(map[int64]string)
	}
	if h.presenceCache[sheetID] == signature {
		h.presenceMu.Unlock()
		h.mu.RUnlock()
		return
	}
	h.presenceCache[sheetID] = signature
	h.presenceMu.Unlock()
	slow := make([]*Client, 0)
	for client := range clients {
		if !trySendLocked(client, data) {
			slow = append(slow, client)
		}
	}
	h.mu.RUnlock()
	h.removeSlowClients(slow)
}

// BroadcastToSheet never blocks a request goroutine when the hub queue is
// full. The return value lets callers record or log a dropped update.
func (h *Hub) BroadcastToSheet(sheetID int64, data []byte, sender *Client) bool {
	return h.enqueueBroadcast(&BroadcastMsg{SheetID: sheetID, Data: data, Sender: sender})
}

func (h *Hub) BroadcastToSheetExceptClientID(sheetID int64, data []byte, excludeClientID string) {
	_ = h.enqueueBroadcast(&BroadcastMsg{SheetID: sheetID, Data: data, ExcludeClientID: excludeClientID})
}

func (h *Hub) enqueueBroadcast(msg *BroadcastMsg) bool {
	if h == nil || msg == nil || msg.SheetID <= 0 || len(msg.Data) == 0 || len(msg.Data) > maxBroadcastBytes {
		return false
	}
	msg.Data = append([]byte(nil), msg.Data...)
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

func (h *Hub) broadcastMessage(msg *BroadcastMsg) {
	if msg == nil || len(msg.Data) == 0 {
		return
	}
	h.mu.RLock()
	slow := make([]*Client, 0)
	if clients, ok := h.sheets[msg.SheetID]; ok {
		for client := range clients {
			if client == msg.Sender || (msg.ExcludeClientID != "" && client.ClientID == msg.ExcludeClientID) {
				continue
			}
			if !trySendLocked(client, msg.Data) {
				slow = append(slow, client)
			}
		}
	}
	h.mu.RUnlock()
	h.removeSlowClients(slow)
}

// BroadcastToSheetByUser builds one permission-aware payload per recipient
// user. Multiple tabs owned by the same user reuse the same payload.
func (h *Hub) BroadcastToSheetByUser(sheetID int64, excludeClientID string, payloadForUser func(userID int64) []byte) {
	if h == nil || payloadForUser == nil {
		return
	}
	h.mu.RLock()
	clients := h.sheets[sheetID]
	userIDs := make(map[int64]struct{}, len(clients))
	for client := range clients {
		if excludeClientID == "" || client.ClientID != excludeClientID {
			userIDs[client.UserID] = struct{}{}
		}
	}
	h.mu.RUnlock()

	payloads := make(map[int64][]byte, len(userIDs))
	for userID := range userIDs {
		if payload := payloadForUser(userID); len(payload) > 0 && len(payload) <= maxBroadcastBytes {
			payloads[userID] = append([]byte(nil), payload...)
		}
	}

	h.mu.RLock()
	slow := make([]*Client, 0)
	for client := range h.sheets[sheetID] {
		if excludeClientID != "" && client.ClientID == excludeClientID {
			continue
		}
		if payload := payloads[client.UserID]; len(payload) > 0 && !trySendLocked(client, payload) {
			slow = append(slow, client)
		}
	}
	h.mu.RUnlock()
	h.removeSlowClients(slow)
}

func (h *Hub) BroadcastAll(data []byte) {
	if h == nil || len(data) == 0 || len(data) > maxBroadcastBytes {
		return
	}
	payload := append([]byte(nil), data...)
	h.mu.RLock()
	slow := make([]*Client, 0)
	for client := range h.clients {
		if !trySendLocked(client, payload) {
			slow = append(slow, client)
		}
	}
	h.mu.RUnlock()
	h.removeSlowClients(slow)
}

func (h *Hub) BroadcastToUsers(userIDs []int64, data []byte) {
	if h == nil || len(userIDs) == 0 || len(data) == 0 || len(data) > maxBroadcastBytes {
		return
	}
	allowed := make(map[int64]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if userID > 0 {
			allowed[userID] = struct{}{}
		}
	}
	payload := append([]byte(nil), data...)
	h.mu.RLock()
	slow := make([]*Client, 0)
	for client := range h.clients {
		if _, ok := allowed[client.UserID]; ok && !trySendLocked(client, payload) {
			slow = append(slow, client)
		}
	}
	h.mu.RUnlock()
	h.removeSlowClients(slow)
}

func trySendLocked(client *Client, data []byte) bool {
	if client == nil || client.closed || client.Send == nil {
		return false
	}
	select {
	case client.Send <- data:
		return true
	default:
		return false
	}
}

func (h *Hub) removeSlowClients(clients []*Client) {
	for _, client := range clients {
		h.slowClients.Add(1)
		h.removeClient(client)
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
