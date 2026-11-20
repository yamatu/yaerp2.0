package service

import (
	"fmt"
	"log"
	"sync"
	"time"

	"yaerp/internal/model"
)

const tradeModulesCacheTTL = 30 * time.Second

// tradeModulesCache keeps the workflow switches every order listing needs.
type tradeModulesCache struct {
	mu         sync.Mutex
	modules    model.TradeModules
	visibility model.TradeOwnerVisibility
	loadedAt   time.Time
}

func (s *TradeService) cachedSwitches() (model.TradeModules, model.TradeOwnerVisibility) {
	cache := &s.modulesCache
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if !cache.loadedAt.IsZero() && time.Since(cache.loadedAt) < tradeModulesCacheTTL {
		return cache.modules, cache.visibility
	}
	settings, err := s.repo.GetSettings()
	if err != nil {
		log.Printf("load trade modules: %v", err)
		if cache.loadedAt.IsZero() {
			return model.DefaultTradeModules(), model.DefaultTradeOwnerVisibility()
		}
		return cache.modules, cache.visibility
	}
	cache.modules = settings.Modules
	cache.visibility = settings.OwnerVisibility
	cache.loadedAt = time.Now()
	return cache.modules, cache.visibility
}

// Modules returns the enabled workflow modules.
func (s *TradeService) Modules() model.TradeModules {
	modules, _ := s.cachedSwitches()
	return modules
}

// OwnerVisibility returns what an order's salesperson may see of later stages.
func (s *TradeService) OwnerVisibility() model.TradeOwnerVisibility {
	_, visibility := s.cachedSwitches()
	return visibility
}

func (s *TradeService) requireTradeAdmin(userID int64, message string) error {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return err
	}
	if !admin {
		return fmt.Errorf("%s", message)
	}
	return nil
}

func (s *TradeService) UpdateModules(userID int64, modules model.TradeModules) (*model.TradeSettings, error) {
	if err := s.requireTradeAdmin(userID, "只有管理员可以开关外贸业务功能模块"); err != nil {
		return nil, err
	}
	if err := s.repo.UpdateModules(userID, modules); err != nil {
		return nil, err
	}
	s.modulesCache.mu.Lock()
	s.modulesCache.loadedAt = time.Time{}
	s.modulesCache.mu.Unlock()
	return s.GetSettings(userID)
}

func (s *TradeService) UpdateOwnerVisibility(userID int64, visibility model.TradeOwnerVisibility) (*model.TradeSettings, error) {
	if err := s.requireTradeAdmin(userID, "只有管理员可以修改业务员的查看权限"); err != nil {
		return nil, err
	}
	if err := s.repo.UpdateOwnerVisibility(userID, visibility); err != nil {
		return nil, err
	}
	s.modulesCache.mu.Lock()
	s.modulesCache.loadedAt = time.Time{}
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
