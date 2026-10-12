package service

import (
	"database/sql"
	"errors"
	"fmt"
	"math"
	"mime/multipart"
	"strings"

	"yaerp/internal/model"
)

const maxTradeItemImages = 12

// validateRequestedItemImages only accepts images the caller uploaded
// themselves, so an attachment ID cannot be used to pull in someone else's file.
func (s *TradeService) validateRequestedItemImages(userID int64, inputs []model.CreateTradeOrderItemRequest) error {
	for index, input := range inputs {
		if len(input.ImageAttachmentIDs) > maxTradeItemImages {
			return fmt.Errorf("第 %d 个产品最多上传 %d 张图片", index+1, maxTradeItemImages)
		}
		for _, attachmentID := range input.ImageAttachmentIDs {
			if err := s.validateOwnImageAttachment(userID, attachmentID); err != nil {
				return fmt.Errorf("第 %d 个产品：%w", index+1, err)
			}
		}
	}
	return nil
}

func (s *TradeService) validateOwnImageAttachment(userID, attachmentID int64) error {
	uploader, mimeType, err := s.repo.AttachmentUploader(attachmentID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && uploader != userID) {
		return fmt.Errorf("图片 #%d 不存在或不是本人上传", attachmentID)
	}
	if err != nil {
		return err
	}
	if !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return fmt.Errorf("附件 #%d 不是图片", attachmentID)
	}
	return nil
}

// attachRequestedItemImages relies on items keeping the request order, which
// buildTradeOrderItems and the repo inserts guarantee.
func (s *TradeService) attachRequestedItemImages(userID, orderID int64, items []model.TradeOrderItem, inputs []model.CreateTradeOrderItemRequest) error {
	for index, input := range inputs {
		if index >= len(items) || items[index].ID <= 0 {
			break
		}
		for _, attachmentID := range input.ImageAttachmentIDs {
			if err := s.repo.AddItemImage(orderID, items[index].ID, attachmentID, userID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *TradeService) itemImagesWithURLs(itemIDs []int64, preferInspection bool) (map[int64][]model.TradeItemImage, error) {
	images, err := s.repo.ListItemImages(itemIDs, preferInspection)
	if err != nil {
		return nil, err
	}
	result := make(map[int64][]model.TradeItemImage, len(itemIDs))
	for _, image := range images {
		image.URL, _ = s.uploadSvc.GetFileURL(image.AttachmentID)
		image.ThumbnailURL = s.uploadSvc.GetThumbnailURL(image.AttachmentID, 480)
		result[image.OrderItemID] = append(result[image.OrderItemID], image)
	}
	return result, nil
}

func (s *TradeService) loadOrderItemImages(items []model.TradeOrderItem) error {
	ids := make([]int64, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	byItem, err := s.itemImagesWithURLs(ids, false)
	if err != nil {
		return err
	}
	for index := range items {
		items[index].Images = byItem[items[index].ID]
	}
	return nil
}

func (s *TradeService) itemImageOrderAccess(userID, orderID, itemID int64) error {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return fmt.Errorf("业务单不存在或无权访问")
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return err
	}
	if !s.canViewTradeOrder(userID, order, access) {
		return fmt.Errorf("业务单不存在或无权访问")
	}
	orderAccess, err := s.orderAccessForUser(userID, order, access)
	if err != nil {
		return err
	}
	if !orderAccess.CanManageItemImages {
		return fmt.Errorf("客户询价图片只能在询价、供应商询价和报价阶段由业务单负责人或当前岗位维护；到货实拍请在质检环节上传")
	}
	belongs, err := s.repo.OrderItemBelongsToOrder(orderID, itemID)
	if err != nil {
		return err
	}
	if !belongs {
		return fmt.Errorf("产品不属于当前业务单")
	}
	return nil
}

func (s *TradeService) UploadItemImage(userID, orderID, itemID int64, file multipart.File, header *multipart.FileHeader) (*model.TradeOrder, error) {
	if err := s.itemImageOrderAccess(userID, orderID, itemID); err != nil {
		return nil, err
	}
	existing, err := s.repo.ListItemImages([]int64{itemID}, false)
	if err != nil {
		return nil, err
	}
	inquiryImages := 0
	for _, image := range existing {
		if image.Source == "inquiry" {
			inquiryImages++
		}
	}
	if inquiryImages >= maxTradeItemImages {
		return nil, fmt.Errorf("每个产品最多保存 %d 张客户询价图片", maxTradeItemImages)
	}
	attachment, err := s.uploadSvc.Upload(file, header, userID)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, fmt.Errorf("客户询价图片必须是图片文件")
	}
	if err := s.repo.AddItemImage(orderID, itemID, attachment.ID, userID); err != nil {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, err
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) DeleteItemImage(userID, orderID, itemID, imageID int64) (*model.TradeOrder, error) {
	if err := s.itemImageOrderAccess(userID, orderID, itemID); err != nil {
		return nil, err
	}
	deleted, err := s.repo.DeleteItemImage(orderID, itemID, imageID)
	if err != nil {
		return nil, err
	}
	if !deleted {
		return nil, fmt.Errorf("客户询价图片不存在")
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

// QuoteHistory lists every product ever quoted to a customer. Employees get the
// customer-facing (marked-up) price and goods images only; purchase cost,
// supplier and profit are reserved for admins and the manager position.
func (s *TradeService) QuoteHistory(userID int64, filter model.TradeQuoteHistoryFilter) (*model.TradeQuoteHistory, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	profile := access.profile
	if !profile.IsAdmin && !profile.CanViewOrderProgress && !profile.CanCreateOrders {
		return nil, fmt.Errorf("当前账号没有外贸业务权限")
	}
	canViewCost := profile.CanViewAllOrders
	if !profile.CanViewCustomers {
		filter.CustomerID = 0
	}
	records, err := s.repo.ListQuoteHistory(filter)
	if err != nil {
		return nil, err
	}

	itemIDs := make([]int64, 0, len(records))
	seen := make(map[int64]bool, len(records))
	for _, record := range records {
		if record.OrderItemID > 0 && !seen[record.OrderItemID] {
			seen[record.OrderItemID] = true
			itemIDs = append(itemIDs, record.OrderItemID)
		}
	}
	items, err := s.repo.ListOrderItemsByIDs(itemIDs)
	if err != nil {
		return nil, err
	}
	itemByID := make(map[int64]*model.TradeOrderItem, len(items))
	for index := range items {
		itemByID[items[index].ID] = &items[index]
	}

	search := strings.ToLower(strings.TrimSpace(filter.Search))
	filtered := make([]model.TradeQuoteHistoryRecord, 0, len(records))
	for _, record := range records {
		item := itemByID[record.OrderItemID]
		if item != nil {
			record.SKU = firstNonEmptyTrade(item.SKU, record.SKU, item.ProductName, record.ProductName)
			record.ProductName = firstNonEmptyTrade(item.ProductName, record.ProductName)
			record.Specification = item.Specification
		} else {
			record.SKU = firstNonEmptyTrade(record.SKU, record.ProductName)
		}
		if search != "" && !tradeHistoryMatches(search, record) {
			continue
		}
		if canViewCost {
			applyTradeHistoryCost(&record, item)
		} else {
			record.ExchangeRateCNY = 0
			record.ProfitMarginPercent = 0
			if record.OwnerID != userID {
				record.CustomerID = 0
				record.CustomerName = ""
			}
		}
		filtered = append(filtered, record)
	}

	visibleItemIDs := make([]int64, 0, len(filtered))
	seen = make(map[int64]bool, len(filtered))
	for _, record := range filtered {
		if record.OrderItemID > 0 && !seen[record.OrderItemID] {
			seen[record.OrderItemID] = true
			visibleItemIDs = append(visibleItemIDs, record.OrderItemID)
		}
	}
	imagesByItem, err := s.itemImagesWithURLs(visibleItemIDs, true)
	if err != nil {
		return nil, err
	}
	for index := range filtered {
		filtered[index].Images = imagesByItem[filtered[index].OrderItemID]
		if filtered[index].Images == nil {
			filtered[index].Images = []model.TradeItemImage{}
		}
	}
	return &model.TradeQuoteHistory{CanViewCost: canViewCost, Records: filtered}, nil
}

func tradeHistoryMatches(search string, record model.TradeQuoteHistoryRecord) bool {
	for _, value := range []string{record.SKU, record.ProductName, record.Specification, record.OrderNo, record.OrderTitle} {
		if strings.Contains(strings.ToLower(value), search) {
			return true
		}
	}
	return false
}

func applyTradeHistoryCost(record *model.TradeQuoteHistoryRecord, item *model.TradeOrderItem) {
	if record == nil || item == nil {
		return
	}
	record.SupplierName = item.SupplierName
	record.PurchaseCurrency = item.PurchaseCurrency
	record.PurchasePrice = item.PurchasePrice
	quoteRate := record.ExchangeRateCNY
	if strings.EqualFold(record.Currency, "CNY") {
		quoteRate = 1
	}
	costRate := tradeProfitExchangeRate(record.Currency, quoteRate, item)
	if item.PurchasePrice <= 0 || costRate <= 0 || quoteRate <= 0 {
		return
	}
	round := func(value float64) float64 { return math.Round(value*10000) / 10000 }
	record.UnitPriceCNY = round(record.UnitPrice * quoteRate)
	record.UnitCostCNY = round(item.PurchasePrice * costRate * quoteRate)
	record.UnitProfitCNY = round(record.UnitPriceCNY - record.UnitCostCNY)
	if record.UnitPriceCNY > 0 {
		record.ProfitMargin = round(record.UnitProfitCNY / record.UnitPriceCNY * 100)
	}
	record.CostComplete = true
}
