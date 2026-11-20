package service

import (
	"fmt"
	"log"
	"sync"
	"time"

	"yaerp/internal/model"
)

const tradeModulesCacheTTL = 30 * time.Second

type tradeModulesCache struct {
	mu       sync.Mutex
	modules  model.TradeModules
	loadedAt time.Time
}

// Modules returns the enabled workflow modules, read through a short cache
// because every order listing needs them.
func (s *TradeService) Modules() model.TradeModules {
	cache := &s.modulesCache
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if !cache.loadedAt.IsZero() && time.Since(cache.loadedAt) < tradeModulesCacheTTL {
		return cache.modules
	}
	settings, err := s.repo.GetSettings()
	if err != nil {
		log.Printf("load trade modules: %v", err)
		if cache.loadedAt.IsZero() {
			return model.DefaultTradeModules()
		}
		return cache.modules
	}
	cache.modules = settings.Modules
	cache.loadedAt = time.Now()
	return cache.modules
}

func (s *TradeService) UpdateModules(userID int64, modules model.TradeModules) (*model.TradeSettings, error) {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !admin {
		return nil, fmt.Errorf("只有管理员可以开关外贸业务功能模块")
	}
	if err := s.repo.UpdateModules(userID, modules); err != nil {
		return nil, err
	}
	s.modulesCache.mu.Lock()
	s.modulesCache.modules = modules
	s.modulesCache.loadedAt = time.Now()
	s.modulesCache.mu.Unlock()
	return s.GetSettings(userID)
}

// nextEnabledTradeStage skips switched-off stages; completed is always on.
func nextEnabledTradeStage(stage string, modules model.TradeModules) string {
	for next := nextTradeStage(stage); next != ""; next = nextTradeStage(next) {
		if modules.StageEnabled(next) {
			return next
		}
	}
	return ""
}

func prevEnabledTradeStage(stage string, modules model.TradeModules) string {
	for prev := prevTradeStage(stage); prev != ""; prev = prevTradeStage(prev) {
		if modules.StageEnabled(prev) {
			return prev
		}
	}
	return ""
}

// confirmedOrderStartStage is where an order the customer already accepted
// and paid begins: the first enabled stage after quoting.
func confirmedOrderStartStage(modules model.TradeModules) string {
	modules.Quotation = false
	return nextEnabledTradeStage(model.TradeStageQuotation, modules)
}
