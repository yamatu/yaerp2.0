package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"

	"yaerp/internal/model"
	"yaerp/internal/repo"
	jwtpkg "yaerp/pkg/jwt"
)

type AuthService struct {
	userRepo *repo.UserRepo
	jwt      *jwtpkg.JWTUtil
	rdb      *redis.Client
}

func NewAuthService(userRepo *repo.UserRepo, jwt *jwtpkg.JWTUtil, rdb *redis.Client) *AuthService {
	return &AuthService{userRepo: userRepo, jwt: jwt, rdb: rdb}
}

func (s *AuthService) Register(req *model.RegisterRequest) error {
	existing, err := s.userRepo.GetByUsername(req.Username)
	if err != nil {
		return fmt.Errorf("failed to check user: %w", err)
	}
	if existing != nil {
		return errors.New("username already exists")
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	user := &model.User{
		Username: req.Username,
		Email:    req.Email,
		Password: string(hashedPassword),
	}

	return s.userRepo.Create(user)
}

func (s *AuthService) Login(req *model.LoginRequest) (*model.TokenResponse, error) {
	user, err := s.userRepo.GetByUsername(req.Username)
	if err != nil {
		return nil, fmt.Errorf("failed to find user: %w", err)
	}
	if user == nil {
		return nil, errors.New("invalid username or password")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password)); err != nil {
		return nil, errors.New("invalid username or password")
	}

	accessToken, err := s.jwt.GenerateToken(user.ID, user.Username)
	if err != nil {
		return nil, fmt.Errorf("failed to generate token: %w", err)
	}

	refreshToken, err := s.jwt.GenerateRefreshToken(user.ID, user.Username)
	if err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}

	return &model.TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    86400,
	}, nil
}

func (s *AuthService) GetProfile(userID int64) (*model.User, error) {
	user, err := s.userRepo.GetByID(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user: %w", err)
	}
	if user == nil {
		return nil, errors.New("user not found")
	}

	roles, err := s.userRepo.GetUserRoles(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user roles: %w", err)
	}
	user.Roles = roles

	return user, nil
}

func (s *AuthService) RefreshToken(refreshToken string) (*model.TokenResponse, error) {
	claims, err := s.jwt.ParseToken(refreshToken)
	if err != nil {
		return nil, errors.New("invalid refresh token")
	}

	ctx := context.Background()
	blacklisted, _ := s.rdb.Get(ctx, "token:blacklist:"+refreshToken).Result()
	if blacklisted != "" {
		return nil, errors.New("token has been revoked")
	}

	accessToken, err := s.jwt.GenerateToken(claims.UserID, claims.Username)
	if err != nil {
		return nil, err
	}

	newRefresh, err := s.jwt.GenerateRefreshToken(claims.UserID, claims.Username)
	if err != nil {
		return nil, err
	}

	// Blacklist old refresh token
	s.rdb.Set(ctx, "token:blacklist:"+refreshToken, "1", 7*24*time.Hour)

	return &model.TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: newRefresh,
		ExpiresIn:    86400,
	}, nil
}

func (s *AuthService) Logout(userID int64) error {
	ctx := context.Background()
	key := fmt.Sprintf("token:blacklist:user:%d", userID)
	return s.rdb.Set(ctx, key, "1", 24*time.Hour).Err()
}
