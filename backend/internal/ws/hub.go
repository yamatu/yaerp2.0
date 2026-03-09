package ws

import (
	"encoding/json"
	"log"
	"sync"
)

type Message struct {
	Type    string          `json:"type"`
	SheetID int64           `json:"sheetId,omitempty"`
	Row     int             `json:"row,omitempty"`
	Col     string          `json:"col,omitempty"`
	Value   json.RawMessage `json:"value,omitempty"`
	Changes json.RawMessage `json:"changes,omitempty"`
	AfterRow int            `json:"afterRow,omitempty"`
	UserID  int64           `json:"userId,omitempty"`
}

type Client struct {
	Hub      *Hub
	UserID   int64
	Username string
	SheetID  int64
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
	SheetID int64
	Data    []byte
	Sender  *Client
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
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				if client.SheetID > 0 {
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

		case msg := <-h.broadcast:
			h.mu.RLock()
			if clients, ok := h.sheets[msg.SheetID]; ok {
				for client := range clients {
					if client != msg.Sender {
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
	defer h.mu.Unlock()

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
	if _, ok := h.sheets[sheetID]; !ok {
		h.sheets[sheetID] = make(map[*Client]bool)
	}
	h.sheets[sheetID][client] = true

	log.Printf("User %s joined sheet %d", client.Username, sheetID)
}

func (h *Hub) BroadcastToSheet(sheetID int64, data []byte, sender *Client) {
	h.broadcast <- &BroadcastMsg{
		SheetID: sheetID,
		Data:    data,
		Sender:  sender,
	}
}
