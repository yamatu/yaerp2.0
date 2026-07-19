package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"

	"yaerp/internal/model"
	"yaerp/internal/repo"
	jwtpkg "yaerp/pkg/jwt"
)

const webSocketTicketTTL = 30 * time.Second

type WebSocketTicketClaims struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
}

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
	if err := s.rdb.Del(context.Background(), jwtpkg.UserRevokedBeforeKey(user.ID)).Err(); err != nil {
		return nil, fmt.Errorf("reset account session state: %w", err)
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
		ExpiresIn:    int(s.jwt.AccessTTL().Seconds()),
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
	claims, err := s.jwt.ParseRefreshToken(refreshToken)
	if err != nil {
		return nil, errors.New("invalid refresh token")
	}

	ctx := context.Background()
	revoked, err := s.tokenRevoked(ctx, refreshToken)
	if err != nil {
		return nil, fmt.Errorf("check refresh token status: %w", err)
	}
	if revoked {
		return nil, errors.New("token has been revoked")
	}
	revokedBefore, err := s.rdb.Get(ctx, jwtpkg.UserRevokedBeforeKey(claims.UserID)).Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, fmt.Errorf("check account session status: %w", err)
	}
	if err == nil && claims.IssuedAt != nil && claims.IssuedAt.Time.Unix() <= revokedBefore {
		return nil, errors.New("account sessions have been revoked")
	}
	user, err := s.userRepo.GetByID(claims.UserID)
	if err != nil || user == nil || user.Status != 1 {
		return nil, errors.New("account is unavailable")
	}

	accessToken, err := s.jwt.GenerateToken(user.ID, user.Username)
	if err != nil {
		return nil, err
	}

	newRefresh, err := s.jwt.GenerateRefreshToken(user.ID, user.Username)
	if err != nil {
		return nil, err
	}

	consumed, err := s.revokeTokenOnce(ctx, refreshToken, claims)
	if err != nil {
		return nil, fmt.Errorf("rotate refresh token: %w", err)
	}
	if !consumed {
		return nil, errors.New("token has already been used")
	}

	return &model.TokenResponse{
		AccessToken:  accessToken,
		RefreshToken: newRefresh,
		ExpiresIn:    int(s.jwt.AccessTTL().Seconds()),
	}, nil
}

func (s *AuthService) Logout(accessToken, refreshToken string) error {
	ctx := context.Background()
	accessClaims, err := s.jwt.ParseAccessToken(accessToken)
	if err != nil {
		return errors.New("invalid access token")
	}
	if err := s.revokeToken(ctx, accessToken, accessClaims); err != nil {
		return err
	}
	if refreshToken == "" {
		return nil
	}
	refreshClaims, err := s.jwt.ParseRefreshToken(refreshToken)
	if err != nil || refreshClaims.UserID != accessClaims.UserID {
		return nil
	}
	return s.revokeToken(ctx, refreshToken, refreshClaims)
}

func (s *AuthService) CreateWebSocketTicket(ctx context.Context, userID int64, username string) (string, int, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", 0, fmt.Errorf("generate websocket ticket: %w", err)
	}
	ticket := base64.RawURLEncoding.EncodeToString(buffer)
	payload, err := json.Marshal(WebSocketTicketClaims{UserID: userID, Username: username})
	if err != nil {
		return "", 0, err
	}
	if err := s.rdb.Set(ctx, websocketTicketKey(ticket), payload, webSocketTicketTTL).Err(); err != nil {
		return "", 0, fmt.Errorf("store websocket ticket: %w", err)
	}
	return ticket, int(webSocketTicketTTL.Seconds()), nil
}

func (s *AuthService) ConsumeWebSocketTicket(ctx context.Context, ticket string) (*WebSocketTicketClaims, error) {
	if ticket == "" {
		return nil, errors.New("websocket ticket is required")
	}
	payload, err := s.rdb.GetDel(ctx, websocketTicketKey(ticket)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, errors.New("websocket ticket is invalid or expired")
	}
	if err != nil {
		return nil, fmt.Errorf("consume websocket ticket: %w", err)
	}
	var claims WebSocketTicketClaims
	if err := json.Unmarshal(payload, &claims); err != nil || claims.UserID <= 0 || claims.Username == "" {
		return nil, errors.New("websocket ticket payload is invalid")
	}
	return &claims, nil
}

func (s *AuthService) tokenRevoked(ctx context.Context, token string) (bool, error) {
	count, err := s.rdb.Exists(ctx, jwtpkg.BlacklistKey(token), "token:blacklist:"+token).Result()
	return count > 0, err
}

func (s *AuthService) revokeToken(ctx context.Context, token string, claims *jwtpkg.Claims) error {
	if claims == nil || claims.ExpiresAt == nil {
		return nil
	}
	ttl := time.Until(claims.ExpiresAt.Time)
	if ttl <= 0 {
		return nil
	}
	return s.rdb.Set(ctx, jwtpkg.BlacklistKey(token), "1", ttl).Err()
}

func (s *AuthService) revokeTokenOnce(ctx context.Context, token string, claims *jwtpkg.Claims) (bool, error) {
	if claims == nil || claims.ExpiresAt == nil {
		return false, nil
	}
	ttl := time.Until(claims.ExpiresAt.Time)
	if ttl <= 0 {
		return false, nil
	}
	return s.rdb.SetNX(ctx, jwtpkg.BlacklistKey(token), "1", ttl).Result()
}

func websocketTicketKey(ticket string) string {
	digest := sha256.Sum256([]byte(ticket))
	return "ws:ticket:sha256:" + hex.EncodeToString(digest[:])
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

func (s *AuthService) RevokeUserSessions(userID int64) error {
	if userID <= 0 {
		return errors.New("invalid user id")
	}
	return s.rdb.Set(
		context.Background(),
		jwtpkg.UserRevokedBeforeKey(userID),
		time.Now().Unix(),
		0,
	).Err()
}
