package service

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/robfig/cron/v3"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

type ReportGenerator func(userID, sheetID int64, filename string) (*model.Attachment, string, error)

type AIScheduleService struct {
	repo            *repo.AIScheduleRepo
	cron            *cron.Cron
	mu              sync.Mutex
	entryIDs        map[int64]cron.EntryID
	reportGenerator ReportGenerator
}

func NewAIScheduleService(repo *repo.AIScheduleRepo) *AIScheduleService {
	return &AIScheduleService{
		repo:     repo,
		cron:     cron.New(cron.WithSeconds()),
		entryIDs: make(map[int64]cron.EntryID),
	}
}

func (s *AIScheduleService) SetReportGenerator(generator ReportGenerator) {
	s.reportGenerator = generator
}

func (s *AIScheduleService) Start() error {
	items, err := s.repo.ListActive()
	if err != nil {
		return err
	}

	for _, item := range items {
		if err := s.register(item); err != nil {
			return err
		}
	}

	s.cron.Start()
	return nil
}

func (s *AIScheduleService) CreateDailyReportSchedule(userID, sheetID int64, timeOfDay, timezone, filenameTemplate string) (*model.AISchedule, error) {
	cronExpr, err := buildDailyCron(timeOfDay)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(timezone) == "" {
		timezone = "Asia/Shanghai"
	}
	if strings.TrimSpace(filenameTemplate) == "" {
		filenameTemplate = "daily-report"
	}

	schedule := &model.AISchedule{
		UserID:           userID,
		SheetID:          sheetID,
		JobType:          "daily_sheet_report",
		CronExpr:         cronExpr,
		Timezone:         timezone,
		FilenameTemplate: filenameTemplate,
		Active:           true,
	}
	if err := s.repo.Create(schedule); err != nil {
		return nil, err
	}
	if err := s.register(*schedule); err != nil {
		return nil, err
	}
	return schedule, nil
}

func (s *AIScheduleService) register(item model.AISchedule) error {
	location, err := time.LoadLocation(item.Timezone)
	if err != nil {
		return fmt.Errorf("load schedule timezone: %w", err)
	}

	job := cron.NewChain().Then(cron.FuncJob(func() {
		if s.reportGenerator == nil {
			_ = s.repo.UpdateRunResult(item.ID, "error", "report generator not configured")
			return
		}

		now := time.Now().In(location)
		filename := fmt.Sprintf("%s-%s.xlsx", item.FilenameTemplate, now.Format("20060102-150405"))
		_, _, err := s.reportGenerator(item.UserID, item.SheetID, filename)
		if err != nil {
			_ = s.repo.UpdateRunResult(item.ID, "error", err.Error())
			return
		}
		_ = s.repo.UpdateRunResult(item.ID, "success", "report generated")
	}))

	entryID, err := s.cron.AddJob(fmt.Sprintf("CRON_TZ=%s %s", item.Timezone, item.CronExpr), job)
	if err != nil {
		return fmt.Errorf("register cron job: %w", err)
	}

	s.mu.Lock()
	s.entryIDs[item.ID] = entryID
	s.mu.Unlock()
	return nil
}

func buildDailyCron(timeOfDay string) (string, error) {
	parsed, err := time.Parse("15:04", strings.TrimSpace(timeOfDay))
	if err != nil {
		return "", fmt.Errorf("invalid daily time, expected HH:MM")
	}
	return fmt.Sprintf("0 %d %d * * *", parsed.Minute(), parsed.Hour()), nil
}
