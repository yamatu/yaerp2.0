package ws

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"yaerp/internal/model"
	"yaerp/internal/service"
	jwtpkg "yaerp/pkg/jwt"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 65536
)

type WSHandler struct {
	Hub          *Hub
	JWTUtil      *jwtpkg.JWTUtil
	PermService  *service.PermissionService
	SheetService *service.SheetService
}

func NewWSHandler(hub *Hub, jwtUtil *jwtpkg.JWTUtil, permService *service.PermissionService, sheetService *service.SheetService) *WSHandler {
	return &WSHandler{Hub: hub, JWTUtil: jwtUtil, PermService: permService, SheetService: sheetService}
}

func (h *WSHandler) HandleWS(c *gin.Context) {
	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "token required"})
		return
	}

	claims, err := h.JWTUtil.ParseToken(token)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	client := &Client{
		Hub:      h.Hub,
		UserID:   claims.UserID,
		Username: claims.Username,
		Send:     make(chan []byte, 256),
	}

	h.Hub.register <- client

	go h.writePump(conn, client)
	go h.readPump(conn, client)
}

func (h *WSHandler) readPump(conn *websocket.Conn, client *Client) {
	defer func() {
		h.Hub.unregister <- client
		conn.Close()
	}()

	conn.SetReadLimit(maxMessageSize)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error: %v", err)
			}
			break
		}

		var msg Message
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Invalid message: %v", err)
			continue
		}

		msg.UserID = client.UserID

		switch msg.Type {
		case "join_sheet":
			matrix, err := h.PermService.GetPermissionMatrix(msg.SheetID, client.UserID)
			if err != nil {
				log.Printf("failed to check sheet permission for user %d: %v", client.UserID, err)
				continue
			}
			if !matrix.Sheet.CanView {
				log.Printf("blocked websocket join for user %d on sheet %d", client.UserID, msg.SheetID)
				continue
			}
			h.Hub.JoinSheet(client, msg.SheetID)

		case "cell_update", "batch_update", "row_insert", "row_delete":
			if err := h.validateMutationMessage(client, &msg); err != nil {
				log.Printf("blocked websocket mutation for user %d on sheet %d: %v", client.UserID, client.SheetID, err)
				continue
			}

			// Broadcast to other users viewing same sheet
			broadcastData, _ := json.Marshal(msg)
			h.Hub.BroadcastToSheet(client.SheetID, broadcastData, client)
		}
	}
}

func (h *WSHandler) validateMutationMessage(client *Client, msg *Message) error {
	if client.SheetID == 0 || client.SheetID != msg.SheetID {
		return fmt.Errorf("client is not joined to target sheet")
	}

	matrix, err := h.PermService.GetPermissionMatrix(client.SheetID, client.UserID)
	if err != nil {
		return err
	}
	if !matrix.Sheet.CanEdit {
		return fmt.Errorf("sheet edit permission denied")
	}

	switch msg.Type {
	case "cell_update":
		return h.validateCellChange(client, msg.Row, msg.Col)
	case "batch_update":
		var changes []model.CellUpdate
		if err := json.Unmarshal(msg.Changes, &changes); err != nil {
			return fmt.Errorf("invalid batch payload: %w", err)
		}
		for _, change := range changes {
			if change.SheetID != client.SheetID {
				return fmt.Errorf("batch contains mismatched sheet id")
			}
			if err := h.validateCellChange(client, change.Row, change.Col); err != nil {
				return err
			}
		}
	case "row_insert":
		return h.validateRowMutation(client, msg.AfterRow)
	case "row_delete":
		return h.validateRowMutation(client, msg.Row)
	}

	return nil
}

func (h *WSHandler) validateCellChange(client *Client, row int, col string) error {
	allowed, err := h.PermService.CheckCellPermission(client.SheetID, client.UserID, col, row, "write")
	if err != nil {
		return err
	}
	if !allowed {
		return fmt.Errorf("cell write permission denied")
	}

	protected, _, err := h.SheetService.CheckProtection(client.SheetID, row, col, client.UserID)
	if err != nil {
		return err
	}
	if protected {
		return fmt.Errorf("cell is protected")
	}

	return nil
}

func (h *WSHandler) validateRowMutation(client *Client, row int) error {
	allowed, err := h.PermService.CheckCellPermission(client.SheetID, client.UserID, "", row, "write")
	if err != nil {
		return err
	}
	if !allowed {
		return fmt.Errorf("row write permission denied")
	}

	protected, _, err := h.SheetService.CheckProtection(client.SheetID, row, "", client.UserID)
	if err != nil {
		return err
	}
	if protected {
		return fmt.Errorf("row is protected")
	}

	return nil
}

func (h *WSHandler) writePump(conn *websocket.Conn, client *Client) {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		conn.Close()
	}()

	for {
		select {
		case message, ok := <-client.Send:
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Drain queued messages
			n := len(client.Send)
			for i := 0; i < n; i++ {
				w.Write([]byte("\n"))
				w.Write(<-client.Send)
			}

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
