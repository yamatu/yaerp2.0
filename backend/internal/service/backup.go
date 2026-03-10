package service

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"yaerp/config"
	"yaerp/migrations"
)

type BackupService struct {
	cfg       *config.Config
	db        *sql.DB
	restoreMu sync.Mutex
}

func NewBackupService(cfg *config.Config, db *sql.DB) *BackupService {
	return &BackupService{cfg: cfg, db: db}
}

// DumpDatabase runs pg_dump and returns the SQL dump as bytes.
func (s *BackupService) DumpDatabase() ([]byte, error) {
	cmd := exec.Command("pg_dump", s.baseCommandArgs("--no-password")...)
	cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", s.cfg.Postgres.Password))
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("pg_dump failed: %s: %w", stderr.String(), err)
	}

	return stdout.Bytes(), nil
}

func (s *BackupService) RestoreDatabase(filename string, payload []byte) error {
	s.restoreMu.Lock()
	defer s.restoreMu.Unlock()

	sqlDump, err := extractRestoreSQL(filename, payload)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(sqlDump)) == 0 {
		return fmt.Errorf("restore file does not contain SQL data")
	}

	resetSQL := []byte(`DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO PUBLIC;`)
	if err := s.runPSQL(resetSQL); err != nil {
		return fmt.Errorf("reset database failed: %w", err)
	}

	if err := s.runPSQL(sqlDump); err != nil {
		return fmt.Errorf("restore database failed: %w", err)
	}

	if err := migrations.Apply(s.db); err != nil {
		return fmt.Errorf("apply migrations after restore failed: %w", err)
	}

	return nil
}

// ExportConfig returns a JSON representation of non-sensitive configuration.
func (s *BackupService) ExportConfig() ([]byte, error) {
	configExport := map[string]interface{}{
		"exported_at": time.Now().Format(time.RFC3339),
		"postgres": map[string]interface{}{
			"host": s.cfg.Postgres.Host,
			"port": s.cfg.Postgres.Port,
			"db":   s.cfg.Postgres.DB,
			"user": s.cfg.Postgres.User,
		},
		"redis": map[string]interface{}{
			"host": s.cfg.Redis.Host,
			"port": s.cfg.Redis.Port,
		},
		"minio": map[string]interface{}{
			"endpoint":        s.cfg.MinIO.Endpoint,
			"bucket":          s.cfg.MinIO.Bucket,
			"public_endpoint": s.cfg.MinIO.PublicEndpoint,
		},
		"server": map[string]interface{}{
			"port": s.cfg.Server.Port,
			"mode": s.cfg.Server.Mode,
		},
	}

	return json.MarshalIndent(configExport, "", "  ")
}

// CombinedBackup creates a tar.gz bundle containing both the SQL dump and config JSON.
func (s *BackupService) CombinedBackup() ([]byte, error) {
	sqlDump, err := s.DumpDatabase()
	if err != nil {
		return nil, fmt.Errorf("database dump failed: %w", err)
	}

	configJSON, err := s.ExportConfig()
	if err != nil {
		return nil, fmt.Errorf("config export failed: %w", err)
	}

	var buf bytes.Buffer
	gzWriter := gzip.NewWriter(&buf)
	tarWriter := tar.NewWriter(gzWriter)

	// Add SQL dump
	if err := addToTar(tarWriter, "database.sql", sqlDump); err != nil {
		return nil, err
	}

	// Add config JSON
	if err := addToTar(tarWriter, "config.json", configJSON); err != nil {
		return nil, err
	}

	if err := tarWriter.Close(); err != nil {
		return nil, fmt.Errorf("close tar writer: %w", err)
	}
	if err := gzWriter.Close(); err != nil {
		return nil, fmt.Errorf("close gzip writer: %w", err)
	}

	return buf.Bytes(), nil
}

func addToTar(tw *tar.Writer, name string, data []byte) error {
	header := &tar.Header{
		Name:    name,
		Size:    int64(len(data)),
		Mode:    0644,
		ModTime: time.Now(),
	}
	if err := tw.WriteHeader(header); err != nil {
		return fmt.Errorf("write tar header for %s: %w", name, err)
	}
	if _, err := tw.Write(data); err != nil {
		return fmt.Errorf("write tar data for %s: %w", name, err)
	}
	return nil
}

func (s *BackupService) baseCommandArgs(extraArgs ...string) []string {
	args := []string{
		"-h", s.cfg.Postgres.Host,
		"-p", fmt.Sprintf("%d", s.cfg.Postgres.Port),
		"-U", s.cfg.Postgres.User,
		"-d", s.cfg.Postgres.DB,
	}
	return append(args, extraArgs...)
}

func (s *BackupService) runPSQL(input []byte) error {
	cmd := exec.Command("psql", s.baseCommandArgs("--no-password", "-v", "ON_ERROR_STOP=1", "-f", "-")...)
	cmd.Env = append(os.Environ(), fmt.Sprintf("PGPASSWORD=%s", s.cfg.Postgres.Password))
	cmd.Stdin = bytes.NewReader(input)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("psql failed: %s: %w", stderr.String(), err)
	}

	return nil
}

func extractRestoreSQL(filename string, payload []byte) ([]byte, error) {
	lowerName := strings.ToLower(filename)

	switch {
	case strings.HasSuffix(lowerName, ".tar.gz") || strings.HasSuffix(lowerName, ".tgz"):
		return extractSQLFromTarGz(payload)
	case strings.HasSuffix(lowerName, ".sql.gz") || strings.HasSuffix(lowerName, ".gz"):
		return gunzipBytes(payload)
	case strings.HasSuffix(lowerName, ".sql"):
		return payload, nil
	default:
		if bytes.HasPrefix(payload, []byte{0x1f, 0x8b}) {
			return gunzipBytes(payload)
		}
		return payload, nil
	}
}

func gunzipBytes(payload []byte) ([]byte, error) {
	reader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("open gzip: %w", err)
	}
	defer reader.Close()

	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, fmt.Errorf("read gzip content: %w", err)
	}

	return data, nil
}

func extractSQLFromTarGz(payload []byte) ([]byte, error) {
	gzReader, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("open backup archive: %w", err)
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read backup archive: %w", err)
		}
		if header == nil || header.Typeflag != tar.TypeReg {
			continue
		}

		name := strings.ToLower(header.Name)
		if name == "database.sql" || strings.HasSuffix(name, ".sql") {
			data, err := io.ReadAll(tarReader)
			if err != nil {
				return nil, fmt.Errorf("read sql from backup archive: %w", err)
			}
			return data, nil
		}
	}

	return nil, fmt.Errorf("database.sql not found in backup archive")
}
