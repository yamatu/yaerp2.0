package migrations

import (
	"database/sql"
	"embed"
	"fmt"
	"log"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/lib/pq"
)

//go:embed *.sql
var files embed.FS

// Apply executes all embedded SQL migrations in filename order.
// The existing migration scripts are written to be idempotent, so it is safe
// to run them on every startup.
func Apply(db *sql.DB) error {
	entries, err := files.ReadDir(".")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)

	scripts := make([]string, 0, len(names))
	for _, name := range names {
		script, err := files.ReadFile(name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}
		scripts = append(scripts, string(script))
	}

	if err := terminateStaleMigrations(db, scripts); err != nil {
		log.Printf("migrations: could not check for stale migration sessions: %v", err)
	}

	for index, script := range scripts {
		if _, err := db.Exec(script); err != nil {
			return fmt.Errorf("apply migration %s: %w", names[index], err)
		}
	}

	return nil
}

// staleMaintenancePatterns match long data rewrites a previous backend may have
// left running: the operation log compaction (including the version that ran
// as migration 057).
var staleMaintenancePatterns = []string{
	`%jsonb_set(l.metadata, '{field_changes}'%`,
}

// terminateStaleMigrations ends statements that a previous, killed backend
// left running in Postgres. Postgres only notices a vanished client when it
// next writes to it, so a long migration keeps its locks after the backend
// dies, and every later startup waits on them (ALTER TABLE / CREATE INDEX)
// before it can serve a single request.
func terminateStaleMigrations(db *sql.DB, scripts []string) error {
	patterns := append([]string{}, staleMaintenancePatterns...)
	for _, script := range scripts {
		if prefix := scriptPrefix(script, 80); prefix != "" {
			patterns = append(patterns, escapeLike(prefix)+"%")
		}
	}
	var terminated int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM (
		     SELECT pg_terminate_backend(pid)
		     FROM pg_stat_activity
		     WHERE datname = current_database()
		       AND pid <> pg_backend_pid()
		       AND state <> 'idle'
		       AND query LIKE ANY($1)
		 ) AS ended`,
		pq.Array(patterns),
	).Scan(&terminated)
	if err != nil {
		return err
	}
	if terminated > 0 {
		log.Printf("migrations: ended %d statement(s) left running by a previous backend", terminated)
	}
	return nil
}

func scriptPrefix(script string, maxBytes int) string {
	var builder strings.Builder
	for _, r := range script {
		if builder.Len()+utf8.RuneLen(r) > maxBytes {
			break
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}
