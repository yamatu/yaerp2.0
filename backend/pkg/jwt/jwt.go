package jwt

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	AccessIssuer     = "yaerp"
	RefreshIssuer    = "yaerp-refresh"
	AccessTokenType  = "access"
	RefreshTokenType = "refresh"
)

type Claims struct {
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
	TokenType string `json:"token_type,omitempty"`
	jwt.RegisteredClaims
}

type JWTUtil struct {
	secret       []byte
	expireHours  int
	refreshHours int
}

func New(secret string, expireHours, refreshHours int) *JWTUtil {
	return &JWTUtil{
		secret:       []byte(secret),
		expireHours:  expireHours,
		refreshHours: refreshHours,
	}
}

func (j *JWTUtil) GenerateToken(userID int64, username string) (string, error) {
	claims := Claims{
		UserID:    userID,
		Username:  username,
		TokenType: AccessTokenType,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Duration(j.expireHours) * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    AccessIssuer,
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(j.secret)
}

func (j *JWTUtil) GenerateRefreshToken(userID int64, username string) (string, error) {
	claims := Claims{
		UserID:    userID,
		Username:  username,
		TokenType: RefreshTokenType,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Duration(j.refreshHours) * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    RefreshIssuer,
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(j.secret)
}

func (j *JWTUtil) ParseAccessToken(tokenString string) (*Claims, error) {
	return j.parseToken(tokenString, AccessIssuer, AccessTokenType)
}

func (j *JWTUtil) ParseRefreshToken(tokenString string) (*Claims, error) {
	return j.parseToken(tokenString, RefreshIssuer, RefreshTokenType)
}

// ParseToken remains an access-token parser for existing callers.
func (j *JWTUtil) ParseToken(tokenString string) (*Claims, error) {
	return j.ParseAccessToken(tokenString)
}

func (j *JWTUtil) parseToken(tokenString, expectedIssuer, expectedType string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, func(token *jwt.Token) (interface{}, error) {
		return j.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithIssuer(expectedIssuer))
	if err != nil {
		return nil, err
	}
	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		// Tokens issued before token_type was introduced are accepted only when
		// their issuer already identifies the expected token class.
		if claims.TokenType != "" && claims.TokenType != expectedType {
			return nil, fmt.Errorf("unexpected token type %q", claims.TokenType)
		}
		if claims.UserID <= 0 {
			return nil, errors.New("invalid token subject")
		}
		return claims, nil
	}
	return nil, errors.New("invalid token")
}

func (j *JWTUtil) AccessTTL() time.Duration {
	return time.Duration(j.expireHours) * time.Hour
}

func BlacklistKey(token string) string {
	digest := sha256.Sum256([]byte(token))
	return "token:blacklist:sha256:" + hex.EncodeToString(digest[:])
}

func UserRevokedBeforeKey(userID int64) string {
	return "user:sessions:revoked-before:" + strconv.FormatInt(userID, 10)
}
