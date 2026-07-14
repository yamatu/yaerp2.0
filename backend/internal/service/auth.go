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
	_, err := s.createUser(req.Username, req.Email, req.Password)
	return err
}

func (s *AuthService) CreateUser(req *model.CreateUserRequest) (*model.User, error) {
	return s.createUser(req.Username, req.Email, req.Password)
}

func (s *AuthService) createUser(username, email, password string) (*model.User, error) {
	existing, err := s.userRepo.GetByUsername(username)
	if err != nil {
		return nil, fmt.Errorf("failed to check user: %w", err)
	}
	if existing != nil {
		return nil, errors.New("username already exists")
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	user := &model.User{
		Username: username,
		Email:    email,
		Password: string(hashedPassword),
	}

	if err := s.userRepo.Create(user); err != nil {
		return nil, err
	}

	return user, nil
}

func (s *AuthService) Login(req *model.LoginRequest) (*model.TokenResponse, error) {
	user, err := s.userRepo.GetByUsername(req.Username)
	if err != nil {
		return nil, fmt.Errorf("failed to find user: %w", err)
	}
	if user == nil {
		return nil, errors.New("invalid username or password")
	}
	if user.Status != 1 {
		return nil, errors.New("account is disabled")
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

func (s *AuthService) ChangePassword(userID int64, currentPassword, newPassword string) error {
	user, err := s.userRepo.GetByID(userID)
	if err != nil {
		return fmt.Errorf("failed to get user: %w", err)
	}
	if user == nil {
		return errors.New("user not found")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(currentPassword)); err != nil {
		return errors.New("current password is incorrect")
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	if err := s.userRepo.UpdatePassword(userID, string(hashedPassword)); err != nil {
		return err
	}

	return nil
}

func (s *AuthService) ResetPassword(userID int64, newPassword string) error {
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	return s.userRepo.UpdatePassword(userID, string(hashedPassword))
}
