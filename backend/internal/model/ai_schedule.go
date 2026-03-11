package model

import "time"

type AISchedule struct {
	ID               int64      `json:"id" db:"id"`
	UserID           int64      `json:"user_id" db:"user_id"`
	SheetID          int64      `json:"sheet_id" db:"sheet_id"`
	JobType          string     `json:"job_type" db:"job_type"`
	CronExpr         string     `json:"cron_expr" db:"cron_expr"`
	Timezone         string     `json:"timezone" db:"timezone"`
	FilenameTemplate string     `json:"filename_template" db:"filename_template"`
	Active           bool       `json:"active" db:"active"`
	LastRunAt        *time.Time `json:"last_run_at,omitempty" db:"last_run_at"`
	LastStatus       *string    `json:"last_status,omitempty" db:"last_status"`
	LastMessage      *string    `json:"last_message,omitempty" db:"last_message"`
	CreatedAt        time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at" db:"updated_at"`
}
