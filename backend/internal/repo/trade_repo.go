package repo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lib/pq"

	"yaerp/internal/model"
)

type TradeRepo struct {
	db *sql.DB
}

func NewTradeRepo(db *sql.DB) *TradeRepo {
	return &TradeRepo{db: db}
}

type tradeRowScanner interface {
	Scan(dest ...any) error
}

const tradeOrderItemSelect = `
	SELECT id, order_id, line_no, sku, product_name, description, specification, quantity,
	       unit, target_price, quoted_price, supplier_name, purchase_currency, purchase_price,
	       received_quantity, accepted_quantity, packed_quantity, carton_count, hs_code,
	       gross_weight, net_weight, status, workflow_data, created_at, updated_at
	FROM trade_order_items`

func scanTradeOrderItem(scanner tradeRowScanner) (*model.TradeOrderItem, error) {
	var item model.TradeOrderItem
	var workflowRaw []byte
	if err := scanner.Scan(
		&item.ID, &item.OrderID, &item.LineNo, &item.SKU, &item.ProductName, &item.Description,
		&item.Specification, &item.Quantity, &item.Unit, &item.TargetPrice, &item.QuotedPrice,
		&item.SupplierName, &item.PurchaseCurrency, &item.PurchasePrice, &item.ReceivedQuantity,
		&item.AcceptedQuantity, &item.PackedQuantity, &item.CartonCount, &item.HSCode,
		&item.GrossWeight, &item.NetWeight, &item.Status, &workflowRaw, &item.CreatedAt, &item.UpdatedAt,
	); err != nil {
		return nil, err
	}
	item.WorkflowData = map[string]any{}
	if len(workflowRaw) > 0 {
		if err := json.Unmarshal(workflowRaw, &item.WorkflowData); err != nil {
			return nil, err
		}
	}
	return &item, nil
}

const tradeCustomerSelect = `
	SELECT c.id, c.customer_code, c.owner_id, COALESCE(u.username, ''), c.name, c.company_name,
	       c.country, c.region, c.contact_name, c.email, c.phone, c.source, c.status,
	       c.customer_level, c.whatsapp_account_id, COALESCE(c.whatsapp_chat_id, ''),
	       c.whatsapp_chat_name, c.avatar_url, c.channel_id, c.tags, c.notes,
	       COUNT(o.id), COUNT(o.id) FILTER (WHERE o.stage NOT IN ('completed', 'cancelled')),
	       c.created_at, c.updated_at
	FROM trade_customers c
	LEFT JOIN users u ON u.id = c.owner_id
	LEFT JOIN trade_orders o ON o.customer_id = c.id AND o.deleted_at IS NULL`

const tradeCustomerGroupBy = `
	GROUP BY c.id, u.username`

func scanTradeCustomer(scanner tradeRowScanner) (*model.TradeCustomer, error) {
	var customer model.TradeCustomer
	var whatsappAccountID, channelID sql.NullInt64
	var tagsRaw []byte
	if err := scanner.Scan(
		&customer.ID, &customer.CustomerCode, &customer.OwnerID, &customer.OwnerName,
		&customer.Name, &customer.CompanyName, &customer.Country, &customer.Region,
		&customer.ContactName, &customer.Email, &customer.Phone, &customer.Source,
		&customer.Status, &customer.CustomerLevel, &whatsappAccountID, &customer.WhatsAppChatID,
		&customer.WhatsAppChatName, &customer.AvatarURL, &channelID, &tagsRaw, &customer.Notes,
		&customer.OrderCount, &customer.OpenOrderCount, &customer.CreatedAt, &customer.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if whatsappAccountID.Valid {
		customer.WhatsAppAccountID = &whatsappAccountID.Int64
	}
	if channelID.Valid {
		customer.ChannelID = &channelID.Int64
	}
	customer.Tags = []string{}
	if len(tagsRaw) > 0 {
		_ = json.Unmarshal(tagsRaw, &customer.Tags)
	}
	return &customer, nil
}

func (r *TradeRepo) CreateCustomer(customer *model.TradeCustomer) error {
	tags, err := json.Marshal(customer.Tags)
	if err != nil {
		return fmt.Errorf("marshal customer tags: %w", err)
	}
	now := time.Now()
	var sequence int64
	if err := r.db.QueryRow(`SELECT nextval('trade_customer_code_seq')`).Scan(&sequence); err != nil {
		return fmt.Errorf("generate customer code: %w", err)
	}
	customer.CustomerCode = fmt.Sprintf("CUS-%06d", sequence)
	err = r.db.QueryRow(
		`INSERT INTO trade_customers (
			customer_code, owner_id, name, company_name, country, region, contact_name, email, phone,
			source, status, customer_level, whatsapp_account_id, whatsapp_chat_id, whatsapp_chat_name,
			avatar_url, tags, notes, created_at, updated_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'lead',$11,$12,NULLIF($13,''),$14,$15,$16,$17,$18,$18)
		 RETURNING id`,
		customer.CustomerCode, customer.OwnerID, customer.Name, customer.CompanyName, customer.Country,
		customer.Region, customer.ContactName, customer.Email, customer.Phone, customer.Source,
		customer.CustomerLevel, customer.WhatsAppAccountID, customer.WhatsAppChatID,
		customer.WhatsAppChatName, customer.AvatarURL, tags, customer.Notes, now,
	).Scan(&customer.ID)
	if err != nil {
		return fmt.Errorf("create trade customer: %w", err)
	}
	customer.Status = "lead"
	customer.CreatedAt = now
	customer.UpdatedAt = now
	return nil
}

func (r *TradeRepo) UpdateCustomer(customer *model.TradeCustomer) error {
	if customer == nil || customer.ID <= 0 {
		return fmt.Errorf("invalid trade customer")
	}
	tags, err := json.Marshal(customer.Tags)
	if err != nil {
		return fmt.Errorf("marshal customer tags: %w", err)
	}
	result, err := r.db.Exec(
		`UPDATE trade_customers SET
		 name=$2,company_name=$3,country=$4,region=$5,contact_name=$6,email=$7,phone=$8,
		 source=$9,status=$10,customer_level=$11,whatsapp_account_id=$12,
		 whatsapp_chat_id=NULLIF($13,''),whatsapp_chat_name=$14,avatar_url=$15,tags=$16,notes=$17,
		 updated_at=NOW()
		 WHERE id=$1 AND deleted_at IS NULL`,
		customer.ID, customer.Name, customer.CompanyName, customer.Country, customer.Region,
		customer.ContactName, customer.Email, customer.Phone, customer.Source, customer.Status,
		customer.CustomerLevel, customer.WhatsAppAccountID, customer.WhatsAppChatID,
		customer.WhatsAppChatName, customer.AvatarURL, tags, customer.Notes,
	)
	if err != nil {
		return fmt.Errorf("update trade customer: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *TradeRepo) SetCustomerChannel(customerID, ownerID, channelID int64) error {
	result, err := r.db.Exec(
		`UPDATE trade_customers SET channel_id = $3, updated_at = NOW() WHERE id = $1 AND owner_id = $2`,
		customerID, ownerID, channelID,
	)
	if err != nil {
		return fmt.Errorf("link customer channel: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *TradeRepo) GetCustomerByWhatsApp(ownerID int64, chatID string) (*model.TradeCustomer, error) {
	query := tradeCustomerSelect + ` WHERE c.owner_id = $1 AND c.whatsapp_chat_id = $2 AND c.deleted_at IS NULL ` + tradeCustomerGroupBy
	customer, err := scanTradeCustomer(r.db.QueryRow(query, ownerID, strings.TrimSpace(chatID)))
	if err != nil {
		return nil, err
	}
	return customer, nil
}

func (r *TradeRepo) GetCustomer(customerID, userID int64, isAdmin bool) (*model.TradeCustomer, error) {
	query := tradeCustomerSelect + ` WHERE c.id = $1 AND c.deleted_at IS NULL AND ($2 OR c.owner_id = $3) ` + tradeCustomerGroupBy
	customer, err := scanTradeCustomer(r.db.QueryRow(query, customerID, isAdmin, userID))
	if err != nil {
		return nil, err
	}
	return customer, nil
}

func (r *TradeRepo) GetCustomerIncludingDeleted(customerID, userID int64, isAdmin bool) (*model.TradeCustomer, error) {
	query := tradeCustomerSelect + ` WHERE c.id = $1 AND ($2 OR c.owner_id = $3) ` + tradeCustomerGroupBy
	customer, err := scanTradeCustomer(r.db.QueryRow(query, customerID, isAdmin, userID))
	if err != nil {
		return nil, err
	}
	return customer, nil
}

func (r *TradeRepo) ListCustomers(userID int64, isAdmin bool, search string) ([]model.TradeCustomer, error) {
	query := tradeCustomerSelect + `
		WHERE c.deleted_at IS NULL
		  AND ($1 OR c.owner_id = $2)
		  AND ($3 = '' OR CONCAT_WS(' ', c.customer_code, c.name, c.company_name, c.contact_name, c.email, c.phone, c.whatsapp_chat_name) ILIKE '%' || $3 || '%')
	` + tradeCustomerGroupBy + ` ORDER BY c.updated_at DESC, c.id DESC LIMIT 500`
	rows, err := r.db.Query(query, isAdmin, userID, strings.TrimSpace(search))
	if err != nil {
		return nil, fmt.Errorf("list trade customers: %w", err)
	}
	defer rows.Close()
	customers := make([]model.TradeCustomer, 0)
	for rows.Next() {
		customer, err := scanTradeCustomer(rows)
		if err != nil {
			return nil, fmt.Errorf("scan trade customer: %w", err)
		}
		customers = append(customers, *customer)
	}
	return customers, rows.Err()
}

const tradeCustomerDeleteRequestSelect = `
	SELECT dr.id,dr.customer_id,c.customer_code,c.name,c.company_name,
	       dr.requested_by,COALESCE(requester.username,''),dr.reason,dr.status,
	       dr.decided_by,COALESCE(decider.username,''),dr.decision_comment,
	       dr.requested_at,dr.decided_at,dr.updated_at
	FROM trade_customer_delete_requests dr
	JOIN trade_customers c ON c.id=dr.customer_id
	LEFT JOIN users requester ON requester.id=dr.requested_by
	LEFT JOIN users decider ON decider.id=dr.decided_by`

func scanTradeCustomerDeleteRequest(scanner tradeRowScanner) (*model.TradeCustomerDeleteRequest, error) {
	var request model.TradeCustomerDeleteRequest
	var requestedBy, decidedBy sql.NullInt64
	var decidedAt sql.NullTime
	if err := scanner.Scan(
		&request.ID, &request.CustomerID, &request.CustomerCode, &request.CustomerName,
		&request.CustomerCompany, &requestedBy, &request.RequesterName, &request.Reason,
		&request.Status, &decidedBy, &request.DeciderName, &request.DecisionComment,
		&request.RequestedAt, &decidedAt, &request.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if requestedBy.Valid {
		request.RequestedBy = &requestedBy.Int64
	}
	if decidedBy.Valid {
		request.DecidedBy = &decidedBy.Int64
	}
	if decidedAt.Valid {
		request.DecidedAt = &decidedAt.Time
	}
	return &request, nil
}

func (r *TradeRepo) GetCustomerDeleteRequest(requestID int64) (*model.TradeCustomerDeleteRequest, error) {
	return scanTradeCustomerDeleteRequest(r.db.QueryRow(tradeCustomerDeleteRequestSelect+` WHERE dr.id=$1`, requestID))
}

func (r *TradeRepo) GetPendingCustomerDeleteRequest(customerID int64) (*model.TradeCustomerDeleteRequest, error) {
	return scanTradeCustomerDeleteRequest(r.db.QueryRow(
		tradeCustomerDeleteRequestSelect+` WHERE dr.customer_id=$1 AND dr.status='pending'`, customerID,
	))
}

func (r *TradeRepo) ListCustomerDeleteRequests(userID int64, isAdmin bool, status string) ([]model.TradeCustomerDeleteRequest, error) {
	rows, err := r.db.Query(
		tradeCustomerDeleteRequestSelect+`
		 WHERE ($1 OR dr.requested_by=$2)
		   AND ($3='' OR dr.status=$3)
		 ORDER BY CASE WHEN dr.status='pending' THEN 0 ELSE 1 END,dr.requested_at DESC,dr.id DESC
		 LIMIT 500`,
		isAdmin, userID, strings.TrimSpace(status),
	)
	if err != nil {
		return nil, fmt.Errorf("list customer delete requests: %w", err)
	}
	defer rows.Close()
	requests := make([]model.TradeCustomerDeleteRequest, 0)
	for rows.Next() {
		request, scanErr := scanTradeCustomerDeleteRequest(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		requests = append(requests, *request)
	}
	return requests, rows.Err()
}

func (r *TradeRepo) CreateCustomerDeleteRequest(customerID, requestedBy int64, reason string) (*model.TradeCustomerDeleteRequest, error) {
	var requestID int64
	err := r.db.QueryRow(
		`INSERT INTO trade_customer_delete_requests (customer_id,requested_by,reason,status,requested_at,updated_at)
		 SELECT c.id,$2,$3,'pending',NOW(),NOW()
		 FROM trade_customers c
		 WHERE c.id=$1 AND c.deleted_at IS NULL
		 ON CONFLICT (customer_id) WHERE status='pending' DO NOTHING
		 RETURNING id`,
		customerID, requestedBy, strings.TrimSpace(reason),
	).Scan(&requestID)
	if errors.Is(err, sql.ErrNoRows) {
		return r.GetPendingCustomerDeleteRequest(customerID)
	}
	if err != nil {
		return nil, fmt.Errorf("create customer delete request: %w", err)
	}
	return r.GetCustomerDeleteRequest(requestID)
}

func (r *TradeRepo) DecideCustomerDeleteRequest(requestID, adminID int64, decision, comment string) (*model.TradeCustomerDeleteRequest, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin customer delete decision: %w", err)
	}
	defer tx.Rollback()

	var customerID int64
	var status string
	if err := tx.QueryRow(
		`SELECT customer_id,status FROM trade_customer_delete_requests WHERE id=$1 FOR UPDATE`, requestID,
	).Scan(&customerID, &status); err != nil {
		return nil, err
	}
	if status != "pending" {
		return nil, fmt.Errorf("该客户删除申请已经处理")
	}

	nextStatus := "rejected"
	if decision == "approve" {
		nextStatus = "approved"
		result, updateErr := tx.Exec(
			`UPDATE trade_customers SET deleted_at=NOW(),deleted_by=$2,updated_at=NOW()
			 WHERE id=$1 AND deleted_at IS NULL`, customerID, adminID,
		)
		if updateErr != nil {
			return nil, fmt.Errorf("delete trade customer: %w", updateErr)
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			return nil, sql.ErrNoRows
		}
	}
	if _, err := tx.Exec(
		`UPDATE trade_customer_delete_requests
		 SET status=$2,decided_by=$3,decision_comment=$4,decided_at=NOW(),updated_at=NOW()
		 WHERE id=$1`,
		requestID, nextStatus, adminID, strings.TrimSpace(comment),
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit customer delete decision: %w", err)
	}
	return r.GetCustomerDeleteRequest(requestID)
}

func (r *TradeRepo) AdminDeleteCustomer(customerID, adminID int64) (*model.TradeCustomerDeleteRequest, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin deleting trade customer: %w", err)
	}
	defer tx.Rollback()

	var customerName string
	if err := tx.QueryRow(
		`SELECT name FROM trade_customers WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, customerID,
	).Scan(&customerName); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(
		`UPDATE trade_customers SET deleted_at=NOW(),deleted_by=$2,updated_at=NOW() WHERE id=$1`,
		customerID, adminID,
	); err != nil {
		return nil, fmt.Errorf("delete trade customer: %w", err)
	}

	var requestID int64
	err = tx.QueryRow(
		`UPDATE trade_customer_delete_requests
		 SET status='approved',decided_by=$2,decision_comment='管理员直接删除',decided_at=NOW(),updated_at=NOW()
		 WHERE customer_id=$1 AND status='pending'
		 RETURNING id`,
		customerID, adminID,
	).Scan(&requestID)
	if errors.Is(err, sql.ErrNoRows) {
		err = tx.QueryRow(
			`INSERT INTO trade_customer_delete_requests
			 (customer_id,requested_by,reason,status,decided_by,decision_comment,requested_at,decided_at,updated_at)
			 VALUES($1,$2,'管理员直接删除','approved',$2,'管理员直接删除',NOW(),NOW(),NOW()) RETURNING id`,
			customerID, adminID,
		).Scan(&requestID)
	}
	if err != nil {
		return nil, fmt.Errorf("record customer deletion approval for %s: %w", customerName, err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit deleting trade customer: %w", err)
	}
	return r.GetCustomerDeleteRequest(requestID)
}

func (r *TradeRepo) CreateOrder(order *model.TradeOrder, items []model.TradeOrderItem) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin trade order: %w", err)
	}
	defer tx.Rollback()

	var sequence int64
	if err := tx.QueryRow(`SELECT nextval('trade_order_number_seq')`).Scan(&sequence); err != nil {
		return fmt.Errorf("generate trade order number: %w", err)
	}
	order.OrderNo = fmt.Sprintf("FT-%s-%06d", time.Now().Format("20060102"), sequence)
	now := time.Now()
	err = tx.QueryRow(
		`INSERT INTO trade_orders (
			order_no, customer_id, owner_id, title, stage, priority, inquiry_date, quote_deadline,
			expected_ship_date, currency, incoterm, destination_country, destination_port,
			payment_terms, payment_method, total_amount, channel_id, notes, stage_updated_at, created_at, updated_at
		 ) VALUES ($1,$2,$3,$4,'inquiry',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$18)
		 RETURNING id`,
		order.OrderNo, order.CustomerID, order.OwnerID, order.Title, order.Priority, order.InquiryDate,
		order.QuoteDeadline, order.ExpectedShipDate, order.Currency, order.Incoterm,
		order.DestinationCountry, order.DestinationPort, order.PaymentTerms, order.PaymentMethod,
		order.TotalAmount, order.ChannelID, order.Notes, now,
	).Scan(&order.ID)
	if err != nil {
		return fmt.Errorf("create trade order: %w", err)
	}

	for index := range items {
		item := &items[index]
		item.OrderID = order.ID
		item.LineNo = index + 1
		err := tx.QueryRow(
			`INSERT INTO trade_order_items (
				order_id, line_no, sku, product_name, description, specification, quantity, unit,
				target_price, status, created_at, updated_at
			 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$10)
			 RETURNING id`,
			item.OrderID, item.LineNo, item.SKU, item.ProductName, item.Description,
			item.Specification, item.Quantity, item.Unit, item.TargetPrice, now,
		).Scan(&item.ID)
		if err != nil {
			return fmt.Errorf("create trade order item %d: %w", index+1, err)
		}
		item.Status = "pending"
		item.CreatedAt = now
		item.UpdatedAt = now
	}

	snapshot, _ := json.Marshal(map[string]any{"order_no": order.OrderNo, "title": order.Title})
	if _, err := tx.Exec(
		`INSERT INTO trade_order_stage_events (order_id, from_stage, to_stage, actor_id, note, snapshot)
		 VALUES ($1, '', 'inquiry', $2, '创建询价业务单', $3)`,
		order.ID, order.OwnerID, snapshot,
	); err != nil {
		return fmt.Errorf("create trade stage event: %w", err)
	}
	if _, err := tx.Exec(`UPDATE trade_customers SET status = 'active', updated_at = $2 WHERE id = $1`, order.CustomerID, now); err != nil {
		return fmt.Errorf("activate trade customer: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit trade order: %w", err)
	}
	order.Stage = model.TradeStageInquiry
	order.StageUpdatedAt = now
	order.CreatedAt = now
	order.UpdatedAt = now
	return nil
}

func (r *TradeRepo) AddOrderItems(orderID int64, items []model.TradeOrderItem) error {
	if orderID <= 0 || len(items) == 0 {
		return fmt.Errorf("invalid trade order items")
	}
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin adding trade order items: %w", err)
	}
	defer tx.Rollback()

	var lockedOrderID int64
	if err := tx.QueryRow(`SELECT id FROM trade_orders WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, orderID).Scan(&lockedOrderID); err != nil {
		return err
	}
	var nextLineNo int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(line_no),0)+1 FROM trade_order_items WHERE order_id=$1`, orderID).Scan(&nextLineNo); err != nil {
		return fmt.Errorf("load next trade item line: %w", err)
	}
	now := time.Now()
	for index := range items {
		item := &items[index]
		item.OrderID = orderID
		item.LineNo = nextLineNo + index
		if err := tx.QueryRow(
			`INSERT INTO trade_order_items (
				order_id,line_no,sku,product_name,description,specification,quantity,unit,target_price,status,created_at,updated_at
			 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$10) RETURNING id`,
			item.OrderID, item.LineNo, item.SKU, item.ProductName, item.Description,
			item.Specification, item.Quantity, item.Unit, item.TargetPrice, now,
		).Scan(&item.ID); err != nil {
			return fmt.Errorf("add trade order item %d: %w", index+1, err)
		}
		item.Status = "pending"
		item.CreatedAt = now
		item.UpdatedAt = now
	}
	if _, err := tx.Exec(`UPDATE trade_orders SET updated_at=$2 WHERE id=$1 AND deleted_at IS NULL`, orderID, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *TradeRepo) DeleteOrderAfterCreateFailure(orderID, ownerID int64) error {
	_, err := r.db.Exec(
		`DELETE FROM trade_orders
		 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
		orderID, ownerID,
	)
	return err
}

func (r *TradeRepo) SoftDeleteOrder(orderID, deletedBy int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin deleting trade order: %w", err)
	}
	defer tx.Rollback()

	var workbookID sql.NullInt64
	if err := tx.QueryRow(
		`SELECT workbook_id
		 FROM trade_orders
		 WHERE id = $1 AND deleted_at IS NULL
		 FOR UPDATE`, orderID,
	).Scan(&workbookID); err != nil {
		return err
	}

	deletedAt := time.Now()
	result, err := tx.Exec(
		`UPDATE trade_orders
		 SET deleted_at = $2, deleted_by = $3, updated_at = $2
		 WHERE id = $1 AND deleted_at IS NULL`,
		orderID, deletedAt, deletedBy,
	)
	if err != nil {
		return fmt.Errorf("delete trade order: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	if workbookID.Valid {
		if _, err := tx.Exec(
			`UPDATE workbooks
			 SET deleted_at = $2,
			     deleted_by = $3,
			     updated_at = $2
			 WHERE id = $1`,
			workbookID.Int64, deletedAt, deletedBy,
		); err != nil {
			return fmt.Errorf("delete trade order workbook: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit deleting trade order: %w", err)
	}
	return nil
}

func (r *TradeRepo) SetOrderWorkspace(orderID, ownerID, workbookID int64) error {
	result, err := r.db.Exec(
		`UPDATE trade_orders SET workbook_id = $3, updated_at = NOW()
		 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
		orderID, ownerID, workbookID,
	)
	if err != nil {
		return fmt.Errorf("link trade workbook: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

const tradeOrderSelect = `
	SELECT o.id, o.order_no, o.customer_id, c.name, c.company_name, c.avatar_url,
	       o.owner_id, COALESCE(u.username, ''), o.title, o.stage, o.priority,
	       o.inquiry_date, o.quote_deadline, o.expected_ship_date, o.currency, o.incoterm,
	       o.destination_country, o.destination_port, o.payment_terms, o.payment_method, o.total_amount,
	       o.quoted_goods_amount, o.quote_exchange_rate_cny, o.freight_mode, o.quoted_freight_amount,
	       COALESCE((SELECT sh.actual_freight_currency FROM trade_order_shipments sh WHERE sh.order_id=o.id),'CNY'),
	       COALESCE((SELECT sh.actual_freight_amount FROM trade_order_shipments sh WHERE sh.order_id=o.id),0),
	       COALESCE((SELECT sh.actual_freight_to_cny_rate FROM trade_order_shipments sh WHERE sh.order_id=o.id),1),
	       COALESCE((SELECT sh.actual_freight_notes FROM trade_order_shipments sh WHERE sh.order_id=o.id),''),
	       o.additional_cost_amount, o.additional_cost_notes,
	       o.workbook_id,
	       (SELECT s.id FROM sheets s WHERE s.workbook_id = o.workbook_id ORDER BY s.sort_order, s.id LIMIT 1),
	       o.channel_id, o.notes, o.label_width_mm, o.label_height_mm,
	       o.label_paper_size, o.label_paper_width_mm, o.label_paper_height_mm, o.label_orientation,
	       o.label_margin_top_mm, o.label_margin_right_mm, o.label_margin_bottom_mm, o.label_margin_left_mm,
	       o.label_gap_x_mm, o.label_gap_y_mm, o.label_content_scale, o.label_start_slot,
	       o.inspection_gallery_directory_id,
	       (SELECT COUNT(*) FROM trade_order_items item WHERE item.order_id = o.id),
	       o.stage_updated_at, o.created_at, o.updated_at
	FROM (SELECT * FROM trade_orders WHERE deleted_at IS NULL) o
	JOIN trade_customers c ON c.id = o.customer_id
	LEFT JOIN users u ON u.id = o.owner_id`

func scanTradeOrder(scanner tradeRowScanner) (*model.TradeOrder, error) {
	var order model.TradeOrder
	var quoteDeadline, expectedShipDate sql.NullTime
	var workbookID, workbookSheetID, channelID, inspectionGalleryDirectoryID sql.NullInt64
	if err := scanner.Scan(
		&order.ID, &order.OrderNo, &order.CustomerID, &order.CustomerName, &order.CustomerCompany,
		&order.CustomerAvatarURL, &order.OwnerID, &order.OwnerName, &order.Title, &order.Stage,
		&order.Priority, &order.InquiryDate, &quoteDeadline, &expectedShipDate, &order.Currency,
		&order.Incoterm, &order.DestinationCountry, &order.DestinationPort, &order.PaymentTerms,
		&order.PaymentMethod, &order.TotalAmount, &order.QuotedGoodsAmount, &order.QuoteExchangeRateCNY,
		&order.FreightMode, &order.QuotedFreightAmount, &order.ActualFreightCurrency,
		&order.ActualFreightAmount, &order.ActualFreightToCNYRate, &order.ActualFreightNotes,
		&order.AdditionalCostAmount, &order.AdditionalCostNotes,
		&workbookID, &workbookSheetID, &channelID, &order.Notes,
		&order.LabelWidthMM, &order.LabelHeightMM, &order.LabelPaperSize, &order.LabelPaperWidthMM,
		&order.LabelPaperHeightMM, &order.LabelOrientation, &order.LabelMarginTopMM, &order.LabelMarginRightMM,
		&order.LabelMarginBottomMM, &order.LabelMarginLeftMM, &order.LabelGapXMM, &order.LabelGapYMM,
		&order.LabelContentScale, &order.LabelStartSlot, &inspectionGalleryDirectoryID, &order.ItemCount,
		&order.StageUpdatedAt, &order.CreatedAt, &order.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if quoteDeadline.Valid {
		order.QuoteDeadline = &quoteDeadline.Time
	}
	if expectedShipDate.Valid {
		order.ExpectedShipDate = &expectedShipDate.Time
	}
	if workbookID.Valid {
		order.WorkbookID = &workbookID.Int64
	}
	if workbookSheetID.Valid {
		order.WorkbookSheetID = &workbookSheetID.Int64
	}
	if channelID.Valid {
		order.ChannelID = &channelID.Int64
	}
	if inspectionGalleryDirectoryID.Valid {
		order.InspectionGalleryDirectoryID = &inspectionGalleryDirectoryID.Int64
	}
	return &order, nil
}

func (r *TradeRepo) ListOrders(userID int64, isAdmin bool, filter model.TradeOrderFilter) ([]model.TradeOrder, error) {
	return r.ListOrdersScoped(userID, isAdmin, nil, filter)
}

func (r *TradeRepo) ListOrdersScoped(userID int64, canViewAll bool, stages []string, filter model.TradeOrderFilter) ([]model.TradeOrder, error) {
	query := tradeOrderSelect + `
		WHERE ($1 OR o.owner_id = $2 OR o.stage = ANY($3))
		  AND ($4 = '' OR o.stage = $4)
		  AND ($5 = 0 OR o.customer_id = $5)
		  AND ($6 = '' OR CONCAT_WS(' ', o.order_no, o.title, c.name, c.company_name, o.destination_country, o.destination_port) ILIKE '%' || $6 || '%')
		ORDER BY CASE WHEN o.stage IN ('completed', 'cancelled') THEN 1 ELSE 0 END,
		         o.updated_at DESC, o.id DESC
		LIMIT 500`
	rows, err := r.db.Query(
		query, canViewAll, userID, pq.Array(stages), strings.TrimSpace(filter.Stage),
		filter.CustomerID, strings.TrimSpace(filter.Search),
	)
	if err != nil {
		return nil, fmt.Errorf("list trade orders: %w", err)
	}
	defer rows.Close()
	orders := make([]model.TradeOrder, 0)
	for rows.Next() {
		order, err := scanTradeOrder(rows)
		if err != nil {
			return nil, fmt.Errorf("scan trade order: %w", err)
		}
		orders = append(orders, *order)
	}
	return orders, rows.Err()
}

func (r *TradeRepo) GetOrder(orderID, userID int64, isAdmin bool) (*model.TradeOrder, error) {
	query := tradeOrderSelect + ` WHERE o.id = $1 AND ($2 OR o.owner_id = $3)`
	order, err := scanTradeOrder(r.db.QueryRow(query, orderID, isAdmin, userID))
	if err != nil {
		return nil, err
	}
	return order, nil
}

func (r *TradeRepo) ListOrderItems(orderID int64) ([]model.TradeOrderItem, error) {
	rows, err := r.db.Query(tradeOrderItemSelect+` WHERE order_id = $1 ORDER BY line_no, id`, orderID)
	if err != nil {
		return nil, fmt.Errorf("list trade order items: %w", err)
	}
	defer rows.Close()
	items := make([]model.TradeOrderItem, 0)
	for rows.Next() {
		item, err := scanTradeOrderItem(rows)
		if err != nil {
			return nil, fmt.Errorf("scan trade order item: %w", err)
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (r *TradeRepo) ListOrdersForProfit() ([]model.TradeOrder, error) {
	rows, err := r.db.Query(tradeOrderSelect + ` ORDER BY o.updated_at DESC, o.id DESC`)
	if err != nil {
		return nil, fmt.Errorf("list profit orders: %w", err)
	}
	defer rows.Close()
	orders := make([]model.TradeOrder, 0)
	for rows.Next() {
		order, err := scanTradeOrder(rows)
		if err != nil {
			return nil, fmt.Errorf("scan profit order: %w", err)
		}
		orders = append(orders, *order)
	}
	return orders, rows.Err()
}

func (r *TradeRepo) ListAllOrderItems() ([]model.TradeOrderItem, error) {
	rows, err := r.db.Query(tradeOrderItemSelect + `
		WHERE EXISTS (
			SELECT 1 FROM trade_orders active_order
			WHERE active_order.id = trade_order_items.order_id
			  AND active_order.deleted_at IS NULL
		)
		ORDER BY order_id, line_no, id`)
	if err != nil {
		return nil, fmt.Errorf("list all trade order items: %w", err)
	}
	defer rows.Close()
	items := make([]model.TradeOrderItem, 0)
	for rows.Next() {
		item, err := scanTradeOrderItem(rows)
		if err != nil {
			return nil, fmt.Errorf("scan trade order item: %w", err)
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (r *TradeRepo) ListOrderEvents(orderID int64) ([]model.TradeOrderStageEvent, error) {
	rows, err := r.db.Query(
		`SELECT event.id, event.order_id, event.from_stage, event.to_stage, event.actor_id,
		        COALESCE(u.username, ''), event.note, event.snapshot, event.created_at
		 FROM trade_order_stage_events event
		 LEFT JOIN users u ON u.id = event.actor_id
		 WHERE event.order_id = $1 ORDER BY event.created_at, event.id`, orderID,
	)
	if err != nil {
		return nil, fmt.Errorf("list trade stage events: %w", err)
	}
	defer rows.Close()
	events := make([]model.TradeOrderStageEvent, 0)
	for rows.Next() {
		var event model.TradeOrderStageEvent
		var actorID sql.NullInt64
		var snapshotRaw []byte
		if err := rows.Scan(
			&event.ID, &event.OrderID, &event.FromStage, &event.ToStage, &actorID,
			&event.ActorName, &event.Note, &snapshotRaw, &event.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan trade stage event: %w", err)
		}
		if actorID.Valid {
			event.ActorID = &actorID.Int64
		}
		event.Snapshot = map[string]any{}
		if len(snapshotRaw) > 0 {
			_ = json.Unmarshal(snapshotRaw, &event.Snapshot)
		}
		events = append(events, event)
	}
	return events, rows.Err()
}

func (r *TradeRepo) AdvanceOrder(orderID, userID int64, isAdmin bool, expectedStage, nextStage, note string) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin advancing trade order: %w", err)
	}
	defer tx.Rollback()
	var ownerID int64
	var orderNo, title, currentStage string
	if err := tx.QueryRow(
		`SELECT owner_id, order_no, title, stage
		 FROM trade_orders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, orderID,
	).Scan(&ownerID, &orderNo, &title, &currentStage); err != nil {
		return err
	}
	if !isAdmin && ownerID != userID {
		return sql.ErrNoRows
	}
	if currentStage != expectedStage {
		return fmt.Errorf("trade order stage changed from %s to %s", expectedStage, currentStage)
	}
	now := time.Now()
	if _, err := tx.Exec(
		`UPDATE trade_orders SET stage = $2, stage_updated_at = $3, updated_at = $3
		 WHERE id = $1 AND deleted_at IS NULL`,
		orderID, nextStage, now,
	); err != nil {
		return fmt.Errorf("advance trade order: %w", err)
	}
	snapshot, _ := json.Marshal(map[string]any{"order_no": orderNo, "title": title})
	if _, err := tx.Exec(
		`INSERT INTO trade_order_stage_events (order_id, from_stage, to_stage, actor_id, note, snapshot)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		orderID, currentStage, nextStage, userID, strings.TrimSpace(note), snapshot,
	); err != nil {
		return fmt.Errorf("record trade stage event: %w", err)
	}
	return tx.Commit()
}

func (r *TradeRepo) FindOrderBySheetID(sheetID int64) (int64, string, error) {
	var orderID int64
	var sheetName string
	err := r.db.QueryRow(
		`SELECT o.id, s.name
		 FROM sheets s
		 JOIN trade_orders o ON o.workbook_id = s.workbook_id AND o.deleted_at IS NULL
		 WHERE s.id = $1`, sheetID,
	).Scan(&orderID, &sheetName)
	return orderID, sheetName, err
}

func (r *TradeRepo) FindOrderByWorkbookID(workbookID int64) (int64, error) {
	var orderID int64
	err := r.db.QueryRow(`SELECT id FROM trade_orders WHERE workbook_id = $1 AND deleted_at IS NULL`, workbookID).Scan(&orderID)
	return orderID, err
}

func (r *TradeRepo) FirstSheetIDByNames(workbookID int64, names []string) (int64, error) {
	if len(names) == 0 {
		return 0, sql.ErrNoRows
	}
	var sheetID int64
	err := r.db.QueryRow(
		`SELECT id FROM sheets WHERE workbook_id = $1 AND name = ANY($2)
		 ORDER BY array_position($2::text[], name), sort_order, id LIMIT 1`,
		workbookID, pq.Array(names),
	).Scan(&sheetID)
	return sheetID, err
}

func (r *TradeRepo) GetOrderItemByLineNo(orderID int64, lineNo int) (*model.TradeOrderItem, error) {
	return scanTradeOrderItem(r.db.QueryRow(tradeOrderItemSelect+` WHERE order_id = $1 AND line_no = $2`, orderID, lineNo))
}

func (r *TradeRepo) GetOrderItem(orderID, itemID int64) (*model.TradeOrderItem, error) {
	return scanTradeOrderItem(r.db.QueryRow(tradeOrderItemSelect+` WHERE order_id = $1 AND id = $2`, orderID, itemID))
}

func (r *TradeRepo) OrderItemBelongsToOrder(orderID, itemID int64) (bool, error) {
	var exists bool
	err := r.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM trade_order_items WHERE order_id=$1 AND id=$2)`, orderID, itemID).Scan(&exists)
	return exists, err
}

func (r *TradeRepo) UpsertOrderItemFromWorkbook(item *model.TradeOrderItem) error {
	if item == nil || item.OrderID <= 0 || item.LineNo <= 0 {
		return fmt.Errorf("invalid trade order item")
	}
	if strings.TrimSpace(item.ProductName) == "" {
		return nil
	}
	workflowData := item.WorkflowData
	if workflowData == nil {
		workflowData = map[string]any{}
	}
	workflowRaw, err := json.Marshal(workflowData)
	if err != nil {
		return fmt.Errorf("marshal trade item workflow data: %w", err)
	}
	_, err = r.db.Exec(
		`INSERT INTO trade_order_items (
			order_id,line_no,sku,product_name,description,specification,quantity,unit,target_price,
			quoted_price,supplier_name,purchase_currency,purchase_price,received_quantity,accepted_quantity,packed_quantity,
			carton_count,hs_code,gross_weight,net_weight,status,workflow_data,created_at,updated_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),NOW())
		 ON CONFLICT(order_id,line_no) DO UPDATE SET
			sku=EXCLUDED.sku,product_name=EXCLUDED.product_name,description=EXCLUDED.description,
			specification=EXCLUDED.specification,quantity=EXCLUDED.quantity,unit=EXCLUDED.unit,
			target_price=EXCLUDED.target_price,quoted_price=EXCLUDED.quoted_price,
			supplier_name=EXCLUDED.supplier_name,purchase_currency=EXCLUDED.purchase_currency,purchase_price=EXCLUDED.purchase_price,
			received_quantity=EXCLUDED.received_quantity,accepted_quantity=EXCLUDED.accepted_quantity,
			packed_quantity=EXCLUDED.packed_quantity,carton_count=EXCLUDED.carton_count,
			hs_code=EXCLUDED.hs_code,gross_weight=EXCLUDED.gross_weight,net_weight=EXCLUDED.net_weight,
			status=EXCLUDED.status,workflow_data=EXCLUDED.workflow_data,updated_at=NOW()`,
		item.OrderID, item.LineNo, item.SKU, item.ProductName, item.Description, item.Specification,
		item.Quantity, item.Unit, item.TargetPrice, item.QuotedPrice, item.SupplierName, item.PurchaseCurrency,
		item.PurchasePrice, item.ReceivedQuantity, item.AcceptedQuantity, item.PackedQuantity,
		item.CartonCount, item.HSCode, item.GrossWeight, item.NetWeight, item.Status, workflowRaw,
	)
	return err
}

func (r *TradeRepo) UpdateOrderFromWorkbook(order *model.TradeOrder) error {
	if order == nil || order.ID <= 0 {
		return fmt.Errorf("invalid trade order")
	}
	_, err := r.db.Exec(
		`UPDATE trade_orders SET priority=$2,currency=$3,destination_country=$4,destination_port=$5,
		 quote_deadline=$6,payment_method=$7,payment_terms=$7,notes=$8,
		 additional_cost_amount=$9,additional_cost_notes=$10,updated_at=NOW()
		 WHERE id=$1 AND deleted_at IS NULL`,
		order.ID, order.Priority, order.Currency, order.DestinationCountry, order.DestinationPort,
		order.QuoteDeadline, order.PaymentMethod, order.Notes, order.AdditionalCostAmount, order.AdditionalCostNotes,
	)
	return err
}

func (r *TradeRepo) UpdateOrderProfitSettings(orderID int64, additionalCost float64, notes string) error {
	result, err := r.db.Exec(
		`UPDATE trade_orders SET additional_cost_amount=$2,additional_cost_notes=$3,updated_at=NOW()
		 WHERE id=$1 AND deleted_at IS NULL`,
		orderID, additionalCost, strings.TrimSpace(notes),
	)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *TradeRepo) RecalculateOrderTotal(orderID int64) error {
	_, err := r.db.Exec(
		`UPDATE trade_orders SET
		 quoted_goods_amount=COALESCE((SELECT SUM(quantity*quoted_price) FROM trade_order_items WHERE order_id=$1),0),
		 total_amount=COALESCE((SELECT SUM(quantity*quoted_price) FROM trade_order_items WHERE order_id=$1),0)+quoted_freight_amount,
		 updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL`,
		orderID,
	)
	return err
}

func (r *TradeRepo) UpsertShipment(shipment *model.TradeShipment) error {
	if shipment == nil || shipment.OrderID <= 0 {
		return fmt.Errorf("invalid shipment")
	}
	_, err := r.db.Exec(
		`INSERT INTO trade_order_shipments(order_id,booking_no,carrier,vessel_flight,etd,eta,bl_no,shipping_status,
		 actual_freight_currency,actual_freight_amount,actual_freight_to_cny_rate,actual_freight_notes,notes,updated_at)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
		 ON CONFLICT(order_id) DO UPDATE SET booking_no=EXCLUDED.booking_no,carrier=EXCLUDED.carrier,
		 vessel_flight=EXCLUDED.vessel_flight,etd=EXCLUDED.etd,eta=EXCLUDED.eta,bl_no=EXCLUDED.bl_no,
		 shipping_status=EXCLUDED.shipping_status,actual_freight_currency=EXCLUDED.actual_freight_currency,
		 actual_freight_amount=EXCLUDED.actual_freight_amount,actual_freight_to_cny_rate=EXCLUDED.actual_freight_to_cny_rate,
		 actual_freight_notes=EXCLUDED.actual_freight_notes,notes=EXCLUDED.notes,updated_at=NOW()`,
		shipment.OrderID, shipment.BookingNo, shipment.Carrier, shipment.VesselFlight, shipment.ETD,
		shipment.ETA, shipment.BLNo, shipment.ShippingStatus, shipment.ActualFreightCurrency,
		shipment.ActualFreightAmount, shipment.ActualFreightToCNYRate, shipment.ActualFreightNotes, shipment.Notes,
	)
	return err
}

func (r *TradeRepo) GetShipment(orderID int64) (*model.TradeShipment, error) {
	var shipment model.TradeShipment
	var etd, eta sql.NullTime
	err := r.db.QueryRow(
		`SELECT order_id,booking_no,carrier,vessel_flight,etd,eta,bl_no,shipping_status,
		 actual_freight_currency,actual_freight_amount,actual_freight_to_cny_rate,actual_freight_notes,notes,updated_at
		 FROM trade_order_shipments WHERE order_id=$1`, orderID,
	).Scan(&shipment.OrderID, &shipment.BookingNo, &shipment.Carrier, &shipment.VesselFlight, &etd,
		&eta, &shipment.BLNo, &shipment.ShippingStatus, &shipment.ActualFreightCurrency,
		&shipment.ActualFreightAmount, &shipment.ActualFreightToCNYRate, &shipment.ActualFreightNotes,
		&shipment.Notes, &shipment.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if etd.Valid {
		shipment.ETD = &etd.Time
	}
	if eta.Valid {
		shipment.ETA = &eta.Time
	}
	return &shipment, nil
}

func (r *TradeRepo) CreateSupplier(userID int64, supplier *model.TradeSupplier) error {
	if supplier == nil {
		return fmt.Errorf("supplier is required")
	}
	var sequence int64
	if err := r.db.QueryRow(`SELECT nextval('trade_supplier_code_seq')`).Scan(&sequence); err != nil {
		return err
	}
	supplier.SupplierCode = fmt.Sprintf("SUP-%06d", sequence)
	return r.db.QueryRow(
		`INSERT INTO trade_suppliers(supplier_code,owner_id,name,company_name,contact_name,phone,email,whatsapp,
		 country,default_currency,payment_method,status,notes,created_at,updated_at)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,NOW(),NOW()) RETURNING id,created_at,updated_at`,
		supplier.SupplierCode, userID, supplier.Name, supplier.CompanyName, supplier.ContactName,
		supplier.Phone, supplier.Email, supplier.WhatsApp, supplier.Country, supplier.DefaultCurrency,
		supplier.PaymentMethod, supplier.Notes,
	).Scan(&supplier.ID, &supplier.CreatedAt, &supplier.UpdatedAt)
}

func (r *TradeRepo) ListSuppliers(search string) ([]model.TradeSupplier, error) {
	rows, err := r.db.Query(
		`SELECT s.id,s.supplier_code,s.owner_id,COALESCE(u.username,''),s.name,s.company_name,s.contact_name,
		 s.phone,s.email,s.whatsapp,s.country,s.default_currency,s.payment_method,s.status,s.notes,s.created_at,s.updated_at
		 FROM trade_suppliers s LEFT JOIN users u ON u.id=s.owner_id
		 WHERE ($1='' OR CONCAT_WS(' ',s.supplier_code,s.name,s.company_name,s.contact_name,s.phone,s.email,s.whatsapp,s.country,s.default_currency,s.payment_method) ILIKE '%'||$1||'%')
		 ORDER BY s.updated_at DESC,s.id DESC LIMIT 1000`, strings.TrimSpace(search),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]model.TradeSupplier, 0)
	for rows.Next() {
		var supplier model.TradeSupplier
		if err := rows.Scan(&supplier.ID, &supplier.SupplierCode, &supplier.OwnerID, &supplier.OwnerName,
			&supplier.Name, &supplier.CompanyName, &supplier.ContactName, &supplier.Phone, &supplier.Email,
			&supplier.WhatsApp, &supplier.Country, &supplier.DefaultCurrency, &supplier.PaymentMethod,
			&supplier.Status, &supplier.Notes, &supplier.CreatedAt, &supplier.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, supplier)
	}
	return result, rows.Err()
}

func (r *TradeRepo) GetSupplier(supplierID int64) (*model.TradeSupplier, error) {
	var supplier model.TradeSupplier
	err := r.db.QueryRow(
		`SELECT s.id,s.supplier_code,s.owner_id,COALESCE(u.username,''),s.name,s.company_name,s.contact_name,
		 s.phone,s.email,s.whatsapp,s.country,s.default_currency,s.payment_method,s.status,s.notes,s.created_at,s.updated_at
		 FROM trade_suppliers s LEFT JOIN users u ON u.id=s.owner_id WHERE s.id=$1`, supplierID,
	).Scan(&supplier.ID, &supplier.SupplierCode, &supplier.OwnerID, &supplier.OwnerName, &supplier.Name,
		&supplier.CompanyName, &supplier.ContactName, &supplier.Phone, &supplier.Email, &supplier.WhatsApp,
		&supplier.Country, &supplier.DefaultCurrency, &supplier.PaymentMethod, &supplier.Status,
		&supplier.Notes, &supplier.CreatedAt, &supplier.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &supplier, nil
}

func scanTradeSupplierQuote(scanner tradeRowScanner) (*model.TradeSupplierQuote, error) {
	var quote model.TradeSupplierQuote
	var supplierID sql.NullInt64
	var validUntil sql.NullTime
	if err := scanner.Scan(
		&quote.ID, &quote.OrderID, &quote.OrderItemID, &quote.LineNo, &quote.SheetRowIndex,
		&supplierID, &quote.SupplierCode, &quote.SupplierName, &quote.SKU, &quote.ProductName,
		&quote.Currency, &quote.UnitPrice, &quote.MOQ, &quote.LeadTimeDays, &validUntil,
		&quote.IsSelected, &quote.Notes, &quote.CreatedBy, &quote.CreatedByName,
		&quote.CreatedAt, &quote.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if supplierID.Valid {
		quote.SupplierID = &supplierID.Int64
	}
	if validUntil.Valid {
		quote.ValidUntil = &validUntil.Time
	}
	return &quote, nil
}

const tradeSupplierQuoteSelect = `
	SELECT q.id,q.order_id,q.order_item_id,item.line_no,q.sheet_row_index,q.supplier_id,
	       COALESCE(s.supplier_code,''),COALESCE(s.name,''),item.sku,item.product_name,q.currency,
	       q.unit_price,q.moq,q.lead_time_days,q.valid_until,q.is_selected,q.notes,q.created_by,
	       COALESCE(u.username,''),q.created_at,q.updated_at
	FROM trade_supplier_quotes q
	JOIN trade_order_items item ON item.id=q.order_item_id
	LEFT JOIN trade_suppliers s ON s.id=q.supplier_id
	LEFT JOIN users u ON u.id=q.created_by`

func (r *TradeRepo) ListSupplierQuotes(orderID int64) ([]model.TradeSupplierQuote, error) {
	rows, err := r.db.Query(tradeSupplierQuoteSelect+` WHERE q.order_id=$1 ORDER BY q.sheet_row_index,q.id`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]model.TradeSupplierQuote, 0)
	for rows.Next() {
		quote, err := scanTradeSupplierQuote(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *quote)
	}
	return result, rows.Err()
}

func (r *TradeRepo) CreateSupplierQuote(orderID, userID int64, request *model.UpsertTradeSupplierQuoteRequest, validUntil *time.Time) (*model.TradeSupplierQuote, error) {
	var sheetRowIndex int
	if err := r.db.QueryRow(`SELECT COALESCE(MAX(sheet_row_index)+1,0) FROM trade_supplier_quotes WHERE order_id=$1`, orderID).Scan(&sheetRowIndex); err != nil {
		return nil, err
	}
	var quoteID int64
	err := r.db.QueryRow(
		`INSERT INTO trade_supplier_quotes(order_id,order_item_id,supplier_id,sheet_row_index,currency,unit_price,moq,
		 lead_time_days,valid_until,notes,created_by,created_at,updated_at)
		 SELECT $1,item.id,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW()
		 FROM trade_order_items item WHERE item.id=$2 AND item.order_id=$1 RETURNING id`,
		orderID, request.OrderItemID, request.SupplierID, sheetRowIndex, request.Currency, request.UnitPrice,
		request.MOQ, request.LeadTimeDays, validUntil, request.Notes, userID,
	).Scan(&quoteID)
	if err != nil {
		return nil, err
	}
	return scanTradeSupplierQuote(r.db.QueryRow(tradeSupplierQuoteSelect+` WHERE q.id=$1`, quoteID))
}

func (r *TradeRepo) UpsertSupplierQuoteFromSheet(orderID, itemID, supplierID int64, sheetRowIndex int, currency string, unitPrice, moq float64, leadTime int, validUntil *time.Time, notes string, userID int64) (int64, error) {
	var quoteID int64
	err := r.db.QueryRow(
		`INSERT INTO trade_supplier_quotes(order_id,order_item_id,supplier_id,sheet_row_index,currency,unit_price,moq,
		 lead_time_days,valid_until,notes,created_by,created_at,updated_at)
		 VALUES($1,$2,NULLIF($3,0),$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
		 ON CONFLICT(order_id,sheet_row_index) DO UPDATE SET order_item_id=EXCLUDED.order_item_id,
		 supplier_id=EXCLUDED.supplier_id,currency=EXCLUDED.currency,unit_price=EXCLUDED.unit_price,
		 moq=EXCLUDED.moq,lead_time_days=EXCLUDED.lead_time_days,valid_until=EXCLUDED.valid_until,
		 notes=EXCLUDED.notes,updated_at=NOW() RETURNING id`,
		orderID, itemID, supplierID, sheetRowIndex, currency, unitPrice, moq, leadTime, validUntil, notes, userID,
	).Scan(&quoteID)
	return quoteID, err
}

func (r *TradeRepo) SelectSupplierQuote(orderID, quoteID, userID int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var itemID int64
	var supplierName string
	var unitPrice float64
	var purchaseCurrency string
	if err := tx.QueryRow(
		`SELECT q.order_item_id,COALESCE(s.name,''),q.unit_price,q.currency FROM trade_supplier_quotes q
		 LEFT JOIN trade_suppliers s ON s.id=q.supplier_id WHERE q.id=$1 AND q.order_id=$2 FOR UPDATE OF q`,
		quoteID, orderID,
	).Scan(&itemID, &supplierName, &unitPrice, &purchaseCurrency); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE trade_supplier_quotes SET is_selected=FALSE,updated_at=NOW() WHERE order_id=$1 AND order_item_id=$2`, orderID, itemID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE trade_supplier_quotes SET is_selected=TRUE,updated_at=NOW() WHERE id=$1`, quoteID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE trade_order_items SET supplier_name=$2,purchase_price=$3,purchase_currency=$4,updated_at=NOW() WHERE id=$1`, itemID, supplierName, unitPrice, purchaseCurrency); err != nil {
		return err
	}
	return tx.Commit()
}

func scanTradeCustomerQuoteRound(scanner tradeRowScanner) (*model.TradeCustomerQuoteRound, error) {
	var quote model.TradeCustomerQuoteRound
	var itemsRaw []byte
	var sentAt sql.NullTime
	if err := scanner.Scan(
		&quote.ID, &quote.OrderID, &quote.RoundNo, &quote.Currency, &quote.Status,
		&quote.GoodsAmount, &quote.ExchangeRateCNY, &quote.FreightMode, &quote.FreightAmount,
		&quote.TotalAmount, &quote.TotalAmountCNY, &itemsRaw, &quote.CustomerFeedback, &quote.Notes,
		&quote.CreatedBy, &quote.CreatedByName, &sentAt, &quote.CreatedAt, &quote.UpdatedAt,
	); err != nil {
		return nil, err
	}
	quote.Items = []model.TradeCustomerQuoteItem{}
	if len(itemsRaw) > 0 {
		if err := json.Unmarshal(itemsRaw, &quote.Items); err != nil {
			return nil, err
		}
	}
	if sentAt.Valid {
		quote.SentAt = &sentAt.Time
	}
	return &quote, nil
}

const tradeCustomerQuoteRoundSelect = `
	SELECT q.id,q.order_id,q.round_no,q.currency,q.status,q.goods_amount,q.exchange_rate_cny,
	       q.freight_mode,q.freight_amount,q.total_amount,q.total_amount_cny,q.item_prices,
	       q.customer_feedback,q.notes,q.created_by,COALESCE(u.username,''),q.sent_at,q.created_at,q.updated_at
	FROM trade_customer_quote_rounds q
	LEFT JOIN users u ON u.id=q.created_by`

func (r *TradeRepo) ListCustomerQuoteRounds(orderID int64) ([]model.TradeCustomerQuoteRound, error) {
	rows, err := r.db.Query(tradeCustomerQuoteRoundSelect+` WHERE q.order_id=$1 ORDER BY q.round_no DESC,q.id DESC`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]model.TradeCustomerQuoteRound, 0)
	for rows.Next() {
		quote, err := scanTradeCustomerQuoteRound(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *quote)
	}
	return result, rows.Err()
}

func (r *TradeRepo) CreateCustomerQuoteRound(round *model.TradeCustomerQuoteRound) error {
	if round == nil || round.OrderID <= 0 || len(round.Items) == 0 {
		return fmt.Errorf("invalid customer quote round")
	}
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var stage string
	if err := tx.QueryRow(`SELECT stage FROM trade_orders WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, round.OrderID).Scan(&stage); err != nil {
		return err
	}
	if stage != model.TradeStageQuotation {
		return fmt.Errorf("trade order is not in customer quotation stage")
	}
	if err := tx.QueryRow(`SELECT COALESCE(MAX(round_no),0)+1 FROM trade_customer_quote_rounds WHERE order_id=$1`, round.OrderID).Scan(&round.RoundNo); err != nil {
		return err
	}
	itemsRaw, err := json.Marshal(round.Items)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE trade_customer_quote_rounds SET status='superseded',updated_at=NOW() WHERE order_id=$1 AND status IN ('draft','sent','accepted')`, round.OrderID); err != nil {
		return err
	}
	var sentAt sql.NullTime
	if err := tx.QueryRow(
		`INSERT INTO trade_customer_quote_rounds(order_id,round_no,currency,status,goods_amount,exchange_rate_cny,
		 freight_mode,freight_amount,total_amount,total_amount_cny,item_prices,customer_feedback,notes,created_by,
		 sent_at,created_at,updated_at)
		 VALUES($1,$2,$3,$4::varchar(24),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
		        CASE WHEN $4::varchar(24) IN ('sent','accepted') THEN NOW() ELSE NULL END,NOW(),NOW())
		 RETURNING id,sent_at,created_at,updated_at`,
		round.OrderID, round.RoundNo, round.Currency, round.Status, round.GoodsAmount, round.ExchangeRateCNY,
		round.FreightMode, round.FreightAmount, round.TotalAmount, round.TotalAmountCNY, itemsRaw,
		round.CustomerFeedback, round.Notes, round.CreatedBy,
	).Scan(&round.ID, &sentAt, &round.CreatedAt, &round.UpdatedAt); err != nil {
		return err
	}
	if sentAt.Valid {
		round.SentAt = &sentAt.Time
	}
	itemStatus := "待报价"
	if round.Status != "draft" {
		itemStatus = "已报价"
	}
	if round.Status == "accepted" {
		itemStatus = "客户确认"
	}
	for _, item := range round.Items {
		result, err := tx.Exec(
			`UPDATE trade_order_items SET quoted_price=$3,status=$4,updated_at=NOW() WHERE id=$1 AND order_id=$2`,
			item.OrderItemID, round.OrderID, item.UnitPrice, itemStatus,
		)
		if err != nil {
			return err
		}
		if affected, _ := result.RowsAffected(); affected == 0 {
			return fmt.Errorf("customer quote item %d does not belong to order", item.OrderItemID)
		}
	}
	if _, err := tx.Exec(`UPDATE trade_orders SET currency=$2,total_amount=$3,quoted_goods_amount=$4,
	 quote_exchange_rate_cny=$5,freight_mode=$6,quoted_freight_amount=$7,updated_at=NOW()
	 WHERE id=$1 AND deleted_at IS NULL`,
		round.OrderID, round.Currency, round.TotalAmount, round.GoodsAmount, round.ExchangeRateCNY,
		round.FreightMode, round.FreightAmount); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *TradeRepo) UpdateCustomerQuoteRoundStatus(orderID, quoteID int64, status, customerFeedback, notes string) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var stage string
	if err := tx.QueryRow(`SELECT stage FROM trade_orders WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, orderID).Scan(&stage); err != nil {
		return err
	}
	if stage != model.TradeStageQuotation {
		return fmt.Errorf("trade order is not in customer quotation stage")
	}
	var itemsRaw []byte
	var currency, freightMode string
	var goodsAmount, exchangeRateCNY, freightAmount, totalAmount float64
	if err := tx.QueryRow(`SELECT item_prices,currency,goods_amount,exchange_rate_cny,freight_mode,freight_amount,total_amount
	 FROM trade_customer_quote_rounds WHERE id=$1 AND order_id=$2 FOR UPDATE`, quoteID, orderID).Scan(
		&itemsRaw, &currency, &goodsAmount, &exchangeRateCNY, &freightMode, &freightAmount, &totalAmount,
	); err != nil {
		return err
	}
	var items []model.TradeCustomerQuoteItem
	if err := json.Unmarshal(itemsRaw, &items); err != nil {
		return err
	}
	if status == "accepted" {
		if _, err := tx.Exec(`UPDATE trade_customer_quote_rounds SET status='superseded',updated_at=NOW() WHERE order_id=$1 AND status='accepted' AND id<>$2`, orderID, quoteID); err != nil {
			return err
		}
		for _, item := range items {
			if _, err := tx.Exec(`UPDATE trade_order_items SET quoted_price=$3,status='客户确认',updated_at=NOW() WHERE id=$1 AND order_id=$2`, item.OrderItemID, orderID, item.UnitPrice); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`UPDATE trade_orders SET currency=$2,total_amount=$3,quoted_goods_amount=$4,
		 quote_exchange_rate_cny=$5,freight_mode=$6,quoted_freight_amount=$7,updated_at=NOW()
		 WHERE id=$1 AND deleted_at IS NULL`,
			orderID, currency, totalAmount, goodsAmount, exchangeRateCNY, freightMode, freightAmount); err != nil {
			return err
		}
	} else {
		for _, item := range items {
			if _, err := tx.Exec(`UPDATE trade_order_items SET status='已报价',updated_at=NOW() WHERE id=$1 AND order_id=$2`, item.OrderItemID, orderID); err != nil {
				return err
			}
		}
	}
	result, err := tx.Exec(
		`UPDATE trade_customer_quote_rounds SET status=$3::varchar(24),customer_feedback=$4,notes=$5,
		 sent_at=CASE WHEN $3::varchar(24) IN ('sent','accepted') THEN COALESCE(sent_at,NOW()) ELSE sent_at END,updated_at=NOW()
		 WHERE id=$1 AND order_id=$2`, quoteID, orderID, status, customerFeedback, notes,
	)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return tx.Commit()
}

func (r *TradeRepo) ListPositions() ([]model.TradePosition, error) {
	rows, err := r.db.Query(`SELECT id,code,name,description,stage,sort_order,enabled FROM trade_positions ORDER BY sort_order,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	positions := make([]model.TradePosition, 0)
	positionIndex := make(map[int64]int)
	for rows.Next() {
		var position model.TradePosition
		if err := rows.Scan(&position.ID, &position.Code, &position.Name, &position.Description, &position.Stage, &position.SortOrder, &position.Enabled); err != nil {
			return nil, err
		}
		position.Members = []model.TradePositionMember{}
		positionIndex[position.ID] = len(positions)
		positions = append(positions, position)
	}
	memberRows, err := r.db.Query(
		`SELECT up.position_id,u.id,u.username,COALESCE(u.avatar,'') FROM trade_user_positions up
		 JOIN users u ON u.id=up.user_id WHERE u.status=1 ORDER BY u.username,u.id`,
	)
	if err != nil {
		return nil, err
	}
	defer memberRows.Close()
	for memberRows.Next() {
		var positionID int64
		var member model.TradePositionMember
		if err := memberRows.Scan(&positionID, &member.UserID, &member.Username, &member.Avatar); err != nil {
			return nil, err
		}
		if index, ok := positionIndex[positionID]; ok {
			positions[index].Members = append(positions[index].Members, member)
		}
	}
	return positions, memberRows.Err()
}

func (r *TradeRepo) ListUserPositions(userID int64) ([]model.TradePosition, error) {
	rows, err := r.db.Query(
		`SELECT p.id,p.code,p.name,p.description,p.stage,p.sort_order,p.enabled
		 FROM trade_user_positions up
		 JOIN trade_positions p ON p.id=up.position_id
		 WHERE up.user_id=$1 AND p.enabled=TRUE ORDER BY p.sort_order,p.id`, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	positions := make([]model.TradePosition, 0)
	for rows.Next() {
		var position model.TradePosition
		if err := rows.Scan(
			&position.ID, &position.Code, &position.Name, &position.Description,
			&position.Stage, &position.SortOrder, &position.Enabled,
		); err != nil {
			return nil, err
		}
		positions = append(positions, position)
	}
	return positions, rows.Err()
}

func (r *TradeRepo) SetPositionAssignments(assignments map[string][]int64, assignedBy int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for code, userIDs := range assignments {
		var positionID int64
		if err := tx.QueryRow(`SELECT id FROM trade_positions WHERE code=$1`, code).Scan(&positionID); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM trade_user_positions WHERE position_id=$1`, positionID); err != nil {
			return err
		}
		seen := map[int64]struct{}{}
		for _, userID := range userIDs {
			if userID <= 0 {
				continue
			}
			if _, exists := seen[userID]; exists {
				continue
			}
			seen[userID] = struct{}{}
			if _, err := tx.Exec(`INSERT INTO trade_user_positions(user_id,position_id,assigned_by) SELECT $1,$2,$3 FROM users WHERE id=$1 AND status=1`, userID, positionID, assignedBy); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (r *TradeRepo) PositionForStage(stage string) (*model.TradePosition, error) {
	var position model.TradePosition
	err := r.db.QueryRow(
		`SELECT id,code,name,description,stage,sort_order,enabled FROM trade_positions WHERE stage=$1 AND enabled=TRUE ORDER BY sort_order LIMIT 1`,
		stage,
	).Scan(&position.ID, &position.Code, &position.Name, &position.Description, &position.Stage, &position.SortOrder, &position.Enabled)
	return &position, err
}

func (r *TradeRepo) UserHasPosition(userID int64, positionID int64) (bool, error) {
	var exists bool
	err := r.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM trade_user_positions WHERE user_id=$1 AND position_id=$2)`, userID, positionID).Scan(&exists)
	return exists, err
}

func (r *TradeRepo) PositionUserIDs(positionID int64) ([]int64, error) {
	rows, err := r.db.Query(
		`SELECT u.id FROM trade_user_positions up JOIN users u ON u.id=up.user_id
		 WHERE up.position_id=$1 AND u.status=1 ORDER BY u.id`, positionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func (r *TradeRepo) GetSettings() (*model.TradeSettings, error) {
	settings := &model.TradeSettings{
		PaymentMethods: []string{},
		PIProfile: model.TradePIProfile{
			CompanyName:  "YAERP Trading Co., Ltd.",
			AccountName:  "YAERP Trading Co., Ltd.",
			DefaultNotes: "All banking charges outside the beneficiary bank are for the buyer's account.",
		},
	}
	rows, err := r.db.Query(`SELECT setting_key,value FROM trade_settings WHERE setting_key IN ('payment_methods','pi_profile')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var value []byte
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		switch key {
		case "payment_methods":
			if err := json.Unmarshal(value, &settings.PaymentMethods); err != nil {
				return nil, err
			}
		case "pi_profile":
			if err := json.Unmarshal(value, &settings.PIProfile); err != nil {
				return nil, err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return settings, nil
}

func (r *TradeRepo) UpdateSettings(userID int64, settings *model.TradeSettings) error {
	paymentValue, err := json.Marshal(settings.PaymentMethods)
	if err != nil {
		return err
	}
	profileValue, err := json.Marshal(settings.PIProfile)
	if err != nil {
		return err
	}
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, entry := range []struct {
		key   string
		value []byte
	}{
		{key: "payment_methods", value: paymentValue},
		{key: "pi_profile", value: profileValue},
	} {
		if _, err := tx.Exec(
			`INSERT INTO trade_settings(setting_key,value,updated_by,updated_at) VALUES($1,$2,$3,NOW())
			 ON CONFLICT(setting_key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
			entry.key, entry.value, userID,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *TradeRepo) SetInspectionGalleryDirectory(orderID, directoryID int64) error {
	_, err := r.db.Exec(`UPDATE trade_orders SET inspection_gallery_directory_id=$2,updated_at=NOW()
	 WHERE id=$1 AND deleted_at IS NULL`, orderID, directoryID)
	return err
}

func (r *TradeRepo) CreateInspectionPhoto(photo *model.TradeInspectionPhoto) error {
	return r.db.QueryRow(
		`INSERT INTO trade_inspection_photos(order_id,order_item_id,attachment_id,gallery_directory_id,note,uploaded_by,created_at)
		 VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(order_id,attachment_id) DO UPDATE SET
		 order_item_id=EXCLUDED.order_item_id,gallery_directory_id=EXCLUDED.gallery_directory_id,
		 note=EXCLUDED.note RETURNING id,created_at`,
		photo.OrderID, photo.OrderItemID, photo.AttachmentID, photo.GalleryDirectoryID, photo.Note, photo.UploadedBy,
	).Scan(&photo.ID, &photo.CreatedAt)
}

func (r *TradeRepo) ListInspectionPhotos(orderID int64) ([]model.TradeInspectionPhoto, error) {
	rows, err := r.db.Query(
		`SELECT p.id,p.order_id,p.order_item_id,item.line_no,COALESCE(item.sku,''),p.attachment_id,a.filename,
		 p.note,p.uploaded_by,COALESCE(u.username,''),p.gallery_directory_id,p.created_at
		 FROM trade_inspection_photos p JOIN attachments a ON a.id=p.attachment_id
		 LEFT JOIN trade_order_items item ON item.id=p.order_item_id
		 LEFT JOIN users u ON u.id=p.uploaded_by WHERE p.order_id=$1 ORDER BY p.created_at DESC,p.id DESC`, orderID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]model.TradeInspectionPhoto, 0)
	for rows.Next() {
		var photo model.TradeInspectionPhoto
		var itemID, directoryID, lineNo sql.NullInt64
		if err := rows.Scan(&photo.ID, &photo.OrderID, &itemID, &lineNo, &photo.SKU, &photo.AttachmentID,
			&photo.Filename, &photo.Note, &photo.UploadedBy, &photo.UploadedByName, &directoryID, &photo.CreatedAt); err != nil {
			return nil, err
		}
		if itemID.Valid {
			photo.OrderItemID = &itemID.Int64
		}
		if lineNo.Valid {
			value := int(lineNo.Int64)
			photo.OrderItemLineNo = &value
		}
		if directoryID.Valid {
			photo.GalleryDirectoryID = &directoryID.Int64
		}
		result = append(result, photo)
	}
	return result, rows.Err()
}

func (r *TradeRepo) UpdateLabelSettings(orderID int64, request *model.UpdateTradeLabelSettingsRequest) error {
	_, err := r.db.Exec(`UPDATE trade_orders SET label_width_mm=$2,label_height_mm=$3,label_paper_size=$4,
	 label_paper_width_mm=$5,label_paper_height_mm=$6,label_orientation=$7,label_margin_top_mm=$8,
	 label_margin_right_mm=$9,label_margin_bottom_mm=$10,label_margin_left_mm=$11,label_gap_x_mm=$12,
	 label_gap_y_mm=$13,label_content_scale=$14,label_start_slot=$15,updated_at=NOW()
	 WHERE id=$1 AND deleted_at IS NULL`,
		orderID, request.WidthMM, request.HeightMM, request.PaperSize, request.PaperWidthMM,
		request.PaperHeightMM, request.Orientation, request.MarginTopMM, request.MarginRightMM,
		request.MarginBottomMM, request.MarginLeftMM, request.GapXMM, request.GapYMM,
		request.ContentScale, request.StartSlot)
	return err
}

func (r *TradeRepo) Dashboard(userID int64, isAdmin bool) (*model.TradeDashboard, error) {
	return r.DashboardScoped(userID, isAdmin, nil, true)
}

func (r *TradeRepo) DashboardScoped(userID int64, canViewAll bool, stages []string, includeCustomers bool) (*model.TradeDashboard, error) {
	dashboard := &model.TradeDashboard{StageCounts: map[string]int64{}}
	if err := r.db.QueryRow(
		`SELECT COUNT(*) FROM trade_customers WHERE deleted_at IS NULL AND $1 AND ($2 OR owner_id = $3)`, includeCustomers, canViewAll, userID,
	).Scan(&dashboard.CustomerCount); err != nil {
		return nil, fmt.Errorf("count trade customers: %w", err)
	}
	if err := r.db.QueryRow(
		`SELECT
			COUNT(*) FILTER (WHERE stage NOT IN ('completed','cancelled')),
			COUNT(*) FILTER (WHERE stage IN ('inquiry','supplier_quote','quotation')),
			COUNT(*) FILTER (WHERE stage = 'purchase'),
			COUNT(*) FILTER (WHERE stage IN ('receiving','inspection','packing')),
			COUNT(*) FILTER (WHERE stage = 'shipment'),
			COUNT(*) FILTER (WHERE stage IN ('inquiry','supplier_quote','quotation') AND quote_deadline < CURRENT_DATE),
			COUNT(*) FILTER (WHERE stage = 'completed' AND updated_at >= date_trunc('month', CURRENT_DATE))
		 FROM trade_orders
		 WHERE deleted_at IS NULL AND ($1 OR owner_id = $2 OR stage = ANY($3))`,
		canViewAll, userID, pq.Array(stages),
	).Scan(
		&dashboard.ActiveOrderCount, &dashboard.PendingQuoteCount, &dashboard.PurchaseCount,
		&dashboard.WarehouseCount, &dashboard.ShippingCount, &dashboard.OverdueQuoteCount,
		&dashboard.CompletedThisMonth,
	); err != nil {
		return nil, fmt.Errorf("load trade dashboard: %w", err)
	}
	rows, err := r.db.Query(
		`SELECT stage, COUNT(*) FROM trade_orders
		 WHERE deleted_at IS NULL AND ($1 OR owner_id = $2 OR stage = ANY($3)) GROUP BY stage`,
		canViewAll, userID, pq.Array(stages),
	)
	if err != nil {
		return nil, fmt.Errorf("load trade stage counts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var stage string
		var count int64
		if err := rows.Scan(&stage, &count); err != nil {
			return nil, err
		}
		dashboard.StageCounts[stage] = count
	}
	return dashboard, rows.Err()
}
