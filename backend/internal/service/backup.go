package service

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"yaerp/config"
	"yaerp/migrations"
	miniopkg "yaerp/pkg/minio"
)

type BackupService struct {
	cfg       *config.Config
	db        *sql.DB
	minio     *miniopkg.Client
	restoreMu sync.Mutex
}

type backupManifest struct {
	Version            int      `json:"version"`
	ExportedAt         string   `json:"exported_at"`
	Database           string   `json:"database"`
	ObjectStorage      bool     `json:"object_storage"`
	ObjectPrefix       string   `json:"object_prefix,omitempty"`
	MinioBucket        string   `json:"minio_bucket,omitempty"`
	PublicBaseURL      string   `json:"public_base_url,omitempty"`
	IncludedFiles      []string `json:"included_files"`
	SupportedRestore   []string `json:"supported_restore"`
	SupportsObjectData bool     `json:"supports_object_data"`
}

func NewBackupService(cfg *config.Config, db *sql.DB, minioClient *miniopkg.Client) *BackupService {
	return &BackupService{cfg: cfg, db: db, minio: minioClient}
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
		"backup": map[string]interface{}{
			"include_object_storage": s.cfg.Backup.IncludeObjectStorage,
			"object_prefix":          s.cfg.Backup.ObjectPrefix,
		},
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

	includedFiles := []string{"database.sql", "config.json"}

	if s.cfg.Backup.IncludeObjectStorage && s.minio != nil {
		objectFiles, err := s.addObjectStorageBackup(tarWriter)
		if err != nil {
			return nil, fmt.Errorf("object storage backup failed: %w", err)
		}
		includedFiles = append(includedFiles, objectFiles...)
	}

	includedFiles = append(includedFiles, "manifest.json")
	manifestJSON, err := s.ExportManifest(includedFiles)
	if err != nil {
		return nil, fmt.Errorf("manifest export failed: %w", err)
	}
	if err := addToTar(tarWriter, "manifest.json", manifestJSON); err != nil {
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

func (s *BackupService) ExportManifest(includedFiles []string) ([]byte, error) {
	manifest := backupManifest{
		Version:            2,
		ExportedAt:         time.Now().Format(time.RFC3339),
		Database:           s.cfg.Postgres.DB,
		ObjectStorage:      s.cfg.Backup.IncludeObjectStorage && s.minio != nil,
		ObjectPrefix:       s.cfg.Backup.ObjectPrefix,
		MinioBucket:        s.cfg.MinIO.Bucket,
		PublicBaseURL:      s.cfg.Backup.PublicBaseURL,
		IncludedFiles:      includedFiles,
		SupportedRestore:   []string{".sql", ".sql.gz", ".tar.gz", ".tgz"},
		SupportsObjectData: s.cfg.Backup.IncludeObjectStorage && s.minio != nil,
	}
	return json.MarshalIndent(manifest, "", "  ")
}

func (s *BackupService) addObjectStorageBackup(tw *tar.Writer) ([]string, error) {
	ctx := context.Background()
	prefix := s.cfg.Backup.ObjectPrefix
	keys, err := s.minio.ListObjectKeys(ctx, prefix)
	if err != nil {
		return nil, fmt.Errorf("list object keys: %w", err)
	}

	manifest := make([]map[string]any, 0, len(keys))
	includedFiles := make([]string, 0, len(keys)+1)
	for _, key := range keys {
		data, err := s.minio.GetObjectBytes(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("read object %s: %w", key, err)
		}
		relativeName := strings.TrimLeft(strings.TrimPrefix(key, prefix), "/")
		archivePath := filepath.ToSlash(filepath.Join("objects", relativeName))
		if err := addToTar(tw, archivePath, data); err != nil {
			return nil, err
		}
		includedFiles = append(includedFiles, archivePath)
		manifest = append(manifest, map[string]any{
			"object_key":   key,
			"archive_path": archivePath,
			"size":         len(data),
			"url":          s.minio.PublicURLForObject(key),
		})
	}

	manifestJSON, err := json.MarshalIndent(map[string]any{
		"bucket":  s.minio.BucketName(),
		"prefix":  prefix,
		"objects": manifest,
	}, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal object manifest: %w", err)
	}
	if err := addToTar(tw, "objects/manifest.json", manifestJSON); err != nil {
		return nil, err
	}
	includedFiles = append(includedFiles, "objects/manifest.json")
	return includedFiles, nil
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
