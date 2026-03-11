package repo

import (
	"database/sql"
	"fmt"

	"yaerp/internal/model"
)

type AIScheduleRepo struct {
	db *sql.DB
}

func NewAIScheduleRepo(db *sql.DB) *AIScheduleRepo {
	return &AIScheduleRepo{db: db}
}

func (r *AIScheduleRepo) Create(schedule *model.AISchedule) error {
	return r.db.QueryRow(
		`INSERT INTO ai_schedules (user_id, sheet_id, job_type, cron_expr, timezone, filename_template, active)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id, created_at, updated_at`,
		schedule.UserID,
		schedule.SheetID,
		schedule.JobType,
		schedule.CronExpr,
		schedule.Timezone,
		schedule.FilenameTemplate,
		schedule.Active,
	).Scan(&schedule.ID, &schedule.CreatedAt, &schedule.UpdatedAt)
}

func (r *AIScheduleRepo) ListActive() ([]model.AISchedule, error) {
	rows, err := r.db.Query(
		`SELECT id, user_id, sheet_id, job_type, cron_expr, timezone, filename_template, active,
		 last_run_at, last_status, last_message, created_at, updated_at
		 FROM ai_schedules
		 WHERE active = TRUE
		 ORDER BY id`,
	)
	if err != nil {
		return nil, fmt.Errorf("list active schedules: %w", err)
	}
	defer rows.Close()

	items := make([]model.AISchedule, 0)
	for rows.Next() {
		var item model.AISchedule
		if err := rows.Scan(
			&item.ID,
			&item.UserID,
			&item.SheetID,
			&item.JobType,
			&item.CronExpr,
			&item.Timezone,
			&item.FilenameTemplate,
			&item.Active,
			&item.LastRunAt,
			&item.LastStatus,
			&item.LastMessage,
			&item.CreatedAt,
			&item.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan active schedule: %w", err)
		}
		items = append(items, item)
	}

	return items, rows.Err()
}

func (r *AIScheduleRepo) UpdateRunResult(id int64, status, message string) error {
	_, err := r.db.Exec(
		`UPDATE ai_schedules
		 SET last_run_at = NOW(), last_status = $2, last_message = $3, updated_at = NOW()
		 WHERE id = $1`,
		id, status, message,
	)
	if err != nil {
		return fmt.Errorf("update schedule run result: %w", err)
	}
	return nil
}
