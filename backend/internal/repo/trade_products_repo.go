package repo

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lib/pq"

	"yaerp/internal/model"
)

func (r *TradeRepo) AddItemImage(orderID, itemID, attachmentID, userID int64) error {
	_, err := r.db.Exec(
		`INSERT INTO trade_item_images(order_id,order_item_id,attachment_id,uploaded_by,created_at)
		 SELECT item.order_id,item.id,$3,$4,NOW() FROM trade_order_items item
		 WHERE item.order_id=$1 AND item.id=$2
		 ON CONFLICT(order_item_id,attachment_id) DO NOTHING`,
		orderID, itemID, attachmentID, userID,
	)
	return err
}

func (r *TradeRepo) DeleteItemImage(orderID, itemID, imageID int64) (bool, error) {
	result, err := r.db.Exec(
		`DELETE FROM trade_item_images WHERE id=$1 AND order_id=$2 AND order_item_id=$3`,
		imageID, orderID, itemID,
	)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
}

// ListItemImages returns the customer's inquiry images plus item-linked
// inspection (arrival) photos. preferInspection puts the real goods photos first.
func (r *TradeRepo) ListItemImages(itemIDs []int64, preferInspection bool) ([]model.TradeItemImage, error) {
	if len(itemIDs) == 0 {
		return nil, nil
	}
	rows, err := r.db.Query(
		`SELECT id,order_id,order_item_id,attachment_id,filename,source FROM (
		   SELECT i.id,i.order_id,i.order_item_id,i.attachment_id,a.filename,'inquiry' AS source,
		          CASE WHEN $2 THEN 1 ELSE 0 END AS rank,i.created_at
		   FROM trade_item_images i JOIN attachments a ON a.id=i.attachment_id
		   WHERE i.order_item_id = ANY($1)
		   UNION ALL
		   SELECT p.id,p.order_id,p.order_item_id,p.attachment_id,a.filename,'inspection' AS source,
		          CASE WHEN $2 THEN 0 ELSE 1 END AS rank,p.created_at
		   FROM trade_inspection_photos p JOIN attachments a ON a.id=p.attachment_id
		   WHERE p.order_item_id = ANY($1)
		 ) images ORDER BY rank,created_at,id`,
		pq.Array(itemIDs), preferInspection,
	)
	if err != nil {
		return nil, fmt.Errorf("list trade item images: %w", err)
	}
	defer rows.Close()
	result := make([]model.TradeItemImage, 0)
	for rows.Next() {
		var image model.TradeItemImage
		if err := rows.Scan(&image.ID, &image.OrderID, &image.OrderItemID, &image.AttachmentID, &image.Filename, &image.Source); err != nil {
			return nil, err
		}
		result = append(result, image)
	}
	return result, rows.Err()
}

func (r *TradeRepo) ListOrderItemsByIDs(itemIDs []int64) ([]model.TradeOrderItem, error) {
	if len(itemIDs) == 0 {
		return nil, nil
	}
	rows, err := r.db.Query(tradeOrderItemSelect+` WHERE id = ANY($1)`, pq.Array(itemIDs))
	if err != nil {
		return nil, fmt.Errorf("list trade order items by id: %w", err)
	}
	defer rows.Close()
	items := make([]model.TradeOrderItem, 0)
	for rows.Next() {
		item, err := scanTradeOrderItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

// ListQuoteHistory flattens every non-draft customer quote round into one row
// per quoted product. Text search is applied by the caller.
func (r *TradeRepo) ListQuoteHistory(filter model.TradeQuoteHistoryFilter) ([]model.TradeQuoteHistoryRecord, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 3000 {
		limit = 3000
	}
	rows, err := r.db.Query(
		`SELECT q.id,q.round_no,q.status,q.currency,q.exchange_rate_cny,q.profit_margin_percent,
		        COALESCE(q.sent_at,q.created_at),q.item_prices,
		        o.id,o.order_no,o.title,o.stage,o.customer_id,COALESCE(c.name,''),o.owner_id,COALESCE(u.username,'')
		 FROM trade_customer_quote_rounds q
		 JOIN trade_orders o ON o.id=q.order_id AND o.deleted_at IS NULL
		 LEFT JOIN trade_customers c ON c.id=o.customer_id
		 LEFT JOIN users u ON u.id=o.owner_id
		 WHERE q.status <> 'draft' AND ($1::bigint = 0 OR o.customer_id=$1)
		 ORDER BY COALESCE(q.sent_at,q.created_at) DESC,q.id DESC
		 LIMIT $2`,
		filter.CustomerID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list trade quote history: %w", err)
	}
	defer rows.Close()
	result := make([]model.TradeQuoteHistoryRecord, 0)
	for rows.Next() {
		var (
			quoteID, orderID, customerID, ownerID int64
			roundNo                               int
			status, currency                      string
			rate, margin                          float64
			quotedAt                              time.Time
			itemsRaw                              []byte
			orderNo, title, stage                 string
			customerName, ownerName               string
		)
		if err := rows.Scan(&quoteID, &roundNo, &status, &currency, &rate, &margin, &quotedAt, &itemsRaw,
			&orderID, &orderNo, &title, &stage, &customerID, &customerName, &ownerID, &ownerName); err != nil {
			return nil, err
		}
		var items []model.TradeCustomerQuoteItem
		if len(itemsRaw) > 0 {
			if err := json.Unmarshal(itemsRaw, &items); err != nil {
				return nil, fmt.Errorf("decode quote %d items: %w", quoteID, err)
			}
		}
		for _, item := range items {
			result = append(result, model.TradeQuoteHistoryRecord{
				QuoteID: quoteID, RoundNo: roundNo, Status: status,
				OrderID: orderID, OrderNo: orderNo, OrderTitle: title, OrderStage: stage,
				CustomerID: customerID, CustomerName: customerName, OwnerID: ownerID, OwnerName: ownerName,
				OrderItemID: item.OrderItemID, SKU: item.SKU, ProductName: item.ProductName,
				Quantity: item.Quantity, Unit: item.Unit, Currency: currency,
				UnitPrice: item.UnitPrice, Amount: item.Amount, QuotedAt: quotedAt,
				ExchangeRateCNY: rate, ProfitMarginPercent: margin,
			})
		}
	}
	return result, rows.Err()
}

func (r *TradeRepo) AttachmentUploader(attachmentID int64) (int64, string, error) {
	var uploader sql.NullInt64
	var mimeType string
	err := r.db.QueryRow(`SELECT uploader_id,mime_type FROM attachments WHERE id=$1`, attachmentID).Scan(&uploader, &mimeType)
	return uploader.Int64, mimeType, err
}
