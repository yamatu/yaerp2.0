package service

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"os/exec"
	"time"

	"yaerp/config"
)

type BackupService struct {
	cfg *config.Config
}

func NewBackupService(cfg *config.Config) *BackupService {
	return &BackupService{cfg: cfg}
}

// DumpDatabase runs pg_dump and returns the SQL dump as bytes.
func (s *BackupService) DumpDatabase() ([]byte, error) {
	args := []string{
		"-h", s.cfg.Postgres.Host,
		"-p", fmt.Sprintf("%d", s.cfg.Postgres.Port),
		"-U", s.cfg.Postgres.User,
		"-d", s.cfg.Postgres.DB,
		"--no-password",
	}

	cmd := exec.Command("pg_dump", args...)
	cmd.Env = append(cmd.Environ(), fmt.Sprintf("PGPASSWORD=%s", s.cfg.Postgres.Password))

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("pg_dump failed: %s: %w", stderr.String(), err)
	}

	return stdout.Bytes(), nil
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
