package ws

import (
	"encoding/json"
	"log"
	"sync"
)

type Message struct {
	Type      string          `json:"type"`
	SheetID   int64           `json:"sheetId,omitempty"`
	ChannelID int64           `json:"channelId,omitempty"`
	MessageID int64           `json:"messageId,omitempty"`
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
}

type Hub struct {
	clients    map[*Client]bool
	sheets     map[int64]map[*Client]bool // sheetID -> clients
	broadcast  chan *BroadcastMsg
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
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
		broadcast:  make(chan *BroadcastMsg, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()

		case client := <-h.unregister:
			oldSheetID := int64(0)
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				if client.SheetID > 0 {
					oldSheetID = client.SheetID
					if clients, ok := h.sheets[client.SheetID]; ok {
						delete(clients, client)
						if len(clients) == 0 {
							delete(h.sheets, client.SheetID)
						}
					}
				}
				close(client.Send)
			}
			h.mu.Unlock()
			if oldSheetID > 0 {
				h.publishPresence(oldSheetID)
			}

		case msg := <-h.broadcast:
			h.mu.RLock()
			if clients, ok := h.sheets[msg.SheetID]; ok {
				for client := range clients {
					if client != msg.Sender && (msg.ExcludeClientID == "" || client.ClientID != msg.ExcludeClientID) {
						select {
						case client.Send <- msg.Data:
						default:
							go func(c *Client) {
								h.unregister <- c
							}(client)
						}
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) JoinSheet(client *Client, sheetID int64) {
	h.mu.Lock()
	oldSheetID := client.SheetID

	// Leave previous sheet
	if client.SheetID > 0 {
		if clients, ok := h.sheets[client.SheetID]; ok {
			delete(clients, client)
			if len(clients) == 0 {
				delete(h.sheets, client.SheetID)
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
	h.mu.Lock()
	sheetID := client.SheetID
	client.State = state
	client.Row = row
	client.Col = col
	h.mu.Unlock()
	if sheetID > 0 {
		h.publishPresence(sheetID)
	}
}

func (h *Hub) publishPresence(sheetID int64) {
	h.mu.RLock()
	clients := h.sheets[sheetID]
	entries := make([]PresenceEntry, 0, len(clients))
	targets := make([]*Client, 0, len(clients))
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
		targets = append(targets, client)
	}
	h.mu.RUnlock()

	data, err := json.Marshal(Message{Type: "sheet_presence", SheetID: sheetID, Presence: entries})
	if err != nil {
		return
	}
	for _, client := range targets {
		select {
		case client.Send <- data:
		default:
			go func(c *Client) { h.unregister <- c }(client)
		}
	}
}

func (h *Hub) BroadcastToSheet(sheetID int64, data []byte, sender *Client) {
	h.broadcast <- &BroadcastMsg{
		SheetID: sheetID,
		Data:    data,
		Sender:  sender,
	}
}

func (h *Hub) BroadcastToSheetExceptClientID(sheetID int64, data []byte, excludeClientID string) {
	h.broadcast <- &BroadcastMsg{
		SheetID:         sheetID,
		Data:            data,
		ExcludeClientID: excludeClientID,
	}
}

// BroadcastToSheetByUser builds one permission-aware payload per recipient user.
// Multiple tabs owned by the same user reuse the same payload.
func (h *Hub) BroadcastToSheetByUser(sheetID int64, excludeClientID string, payloadForUser func(userID int64) []byte) {
	if payloadForUser == nil {
		return
	}

	h.mu.RLock()
	clients := h.sheets[sheetID]
	userIDs := make(map[int64]struct{}, len(clients))
	for client := range clients {
		if excludeClientID != "" && client.ClientID == excludeClientID {
			continue
		}
		userIDs[client.UserID] = struct{}{}
	}
	h.mu.RUnlock()

	payloads := make(map[int64][]byte, len(userIDs))
	for userID := range userIDs {
		if payload := payloadForUser(userID); len(payload) > 0 {
			payloads[userID] = payload
		}
	}

	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.sheets[sheetID] {
		if excludeClientID != "" && client.ClientID == excludeClientID {
			continue
		}
		payload := payloads[client.UserID]
		if len(payload) == 0 {
			continue
		}
		select {
		case client.Send <- payload:
		default:
			go func(c *Client) { h.unregister <- c }(client)
		}
	}
}

func (h *Hub) BroadcastAll(data []byte) {
	h.mu.RLock()
	targets := make([]*Client, 0, len(h.clients))
	for client := range h.clients {
		targets = append(targets, client)
	}
	h.mu.RUnlock()
	for _, client := range targets {
		select {
		case client.Send <- data:
		default:
			go func(c *Client) { h.unregister <- c }(client)
		}
	}
}
