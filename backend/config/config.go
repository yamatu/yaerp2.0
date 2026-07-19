package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Postgres PostgresConfig
	Redis    RedisConfig
	MinIO    MinIOConfig
	JWT      JWTConfig
	Auth     AuthConfig
	Server   ServerConfig
	AI       AIConfig
	Backup   BackupConfig
	WhatsApp WhatsAppConfig
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

type AuthConfig struct {
	AllowPublicRegistration bool
}

type ServerConfig struct {
	Port           string
	Mode           string
	AllowedOrigins []string
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
	AutomaticEnabled     bool
	Directory            string
	HostDirectory        string
	IntervalHours        int
	RetentionDays        int
}

type WhatsAppConfig struct {
	ServiceURL     string
	InternalSecret string
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
		Auth: AuthConfig{
			AllowPublicRegistration: getEnv("ALLOW_PUBLIC_REGISTRATION", "false") == "true",
		},
		Server: ServerConfig{
			Port:           getEnv("BACKEND_PORT", "8080"),
			Mode:           getEnv("GIN_MODE", "debug"),
			AllowedOrigins: getEnvList("CORS_ALLOWED_ORIGINS", []string{"*"}),
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
			AutomaticEnabled:     getEnv("BACKUP_AUTO_ENABLED", "true") == "true",
			Directory:            getEnv("BACKUP_DIRECTORY", "/backups"),
			HostDirectory:        getEnv("BACKUP_HOST_DIR", "./backups"),
			IntervalHours:        getPositiveEnvInt("BACKUP_INTERVAL_HOURS", 24),
			RetentionDays:        getPositiveEnvInt("BACKUP_RETENTION_DAYS", 30),
		},
		WhatsApp: WhatsAppConfig{
			ServiceURL:     getEnv("WHATSAPP_SERVICE_URL", "http://whatsapp:3010"),
			InternalSecret: getEnv("WHATSAPP_INTERNAL_SECRET", ""),
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

func getPositiveEnvInt(key string, fallback int) int {
	value := getEnvInt(key, fallback)
	if value <= 0 {
		return fallback
	}
	return value
}

func getEnvList(key string, fallback []string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	values := make([]string, 0)
	for _, item := range strings.Split(raw, ",") {
		value := strings.TrimSpace(item)
		if value != "" {
			values = append(values, value)
		}
	}
	if len(values) == 0 {
		return fallback
	}
	return values
}
