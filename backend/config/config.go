package config

import (
	"os"
	"strconv"
)

type Config struct {
	Postgres PostgresConfig
	Redis    RedisConfig
	MinIO    MinIOConfig
	JWT      JWTConfig
	Server   ServerConfig
	AI       AIConfig
	Backup   BackupConfig
}

type PostgresConfig struct {
	Host     string
	Port     int
	DB       string
	User     string
	Password string
}

type RedisConfig struct {
	Host     string
	Port     int
	Password string
}

type MinIOConfig struct {
	Endpoint       string
	AccessKey      string
	SecretKey      string
	Bucket         string
	UseSSL         bool
	PublicEndpoint string
}

type JWTConfig struct {
	Secret       string
	ExpireHours  int
	RefreshHours int
}

type ServerConfig struct {
	Port string
	Mode string
}

type AIConfig struct {
	Endpoint string
	APIKey   string
	Model    string
}

type BackupConfig struct {
	IncludeObjectStorage bool
	ObjectPrefix         string
	PublicBaseURL        string
}

func Load() *Config {
	return &Config{
		Postgres: PostgresConfig{
			Host:     getEnv("POSTGRES_HOST", "localhost"),
			Port:     getEnvInt("POSTGRES_PORT", 5432),
			DB:       getEnv("POSTGRES_DB", "yaerp"),
			User:     getEnv("POSTGRES_USER", "yaerp"),
			Password: getEnv("POSTGRES_PASSWORD", "yaerp_secret_2024"),
		},
		Redis: RedisConfig{
			Host:     getEnv("REDIS_HOST", "localhost"),
			Port:     getEnvInt("REDIS_PORT", 6379),
			Password: getEnv("REDIS_PASSWORD", "redis_secret_2024"),
		},
		MinIO: MinIOConfig{
			Endpoint:       getEnv("MINIO_ENDPOINT", "localhost:9000"),
			AccessKey:      getEnv("MINIO_ACCESS_KEY", "yaerp_minio"),
			SecretKey:      getEnv("MINIO_SECRET_KEY", "minio_secret_2024"),
			Bucket:         getEnv("MINIO_BUCKET", "yaerp"),
			UseSSL:         getEnv("MINIO_USE_SSL", "false") == "true",
			PublicEndpoint: getEnv("MINIO_PUBLIC_ENDPOINT", ""),
		},
		JWT: JWTConfig{
			Secret:       getEnv("JWT_SECRET", "yaerp-jwt-secret-change-me"),
			ExpireHours:  getEnvInt("JWT_EXPIRE_HOURS", 24),
			RefreshHours: getEnvInt("JWT_REFRESH_HOURS", 168),
		},
		Server: ServerConfig{
			Port: getEnv("BACKEND_PORT", "8080"),
			Mode: getEnv("GIN_MODE", "debug"),
		},
		AI: AIConfig{
			Endpoint: getEnv("AI_API_ENDPOINT", ""),
			APIKey:   getEnv("AI_API_KEY", ""),
			Model:    getEnv("AI_MODEL", "gpt-4o-mini"),
		},
		Backup: BackupConfig{
			IncludeObjectStorage: getEnv("BACKUP_INCLUDE_OBJECT_STORAGE", "true") == "true",
			ObjectPrefix:         getEnv("BACKUP_OBJECT_PREFIX", "uploads/"),
			PublicBaseURL:        getEnv("BACKUP_PUBLIC_BASE_URL", ""),
		},
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}
