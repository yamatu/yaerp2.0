package jwt

import (
	"strings"
	"testing"
)

func TestTokenClassesCannotBeInterchanged(t *testing.T) {
	util := New("test-secret", 1, 24)

	accessToken, err := util.GenerateToken(7, "alice")
	if err != nil {
		t.Fatal(err)
	}
	accessClaims, err := util.ParseAccessToken(accessToken)
	if err != nil {
		t.Fatalf("parse access token: %v", err)
	}
	if accessClaims.TokenType != AccessTokenType || accessClaims.Issuer != AccessIssuer {
		t.Fatalf("unexpected access claims: %#v", accessClaims)
	}
	if _, err := util.ParseRefreshToken(accessToken); err == nil {
		t.Fatal("access token was accepted as a refresh token")
	}

	refreshToken, err := util.GenerateRefreshToken(7, "alice")
	if err != nil {
		t.Fatal(err)
	}
	refreshClaims, err := util.ParseRefreshToken(refreshToken)
	if err != nil {
		t.Fatalf("parse refresh token: %v", err)
	}
	if refreshClaims.TokenType != RefreshTokenType || refreshClaims.Issuer != RefreshIssuer {
		t.Fatalf("unexpected refresh claims: %#v", refreshClaims)
	}
	if _, err := util.ParseAccessToken(refreshToken); err == nil {
		t.Fatal("refresh token was accepted as an access token")
	}
}

func TestBlacklistKeyDoesNotContainRawToken(t *testing.T) {
	token := "header.payload.signature"
	key := BlacklistKey(token)
	if strings.Contains(key, token) {
		t.Fatalf("blacklist key exposes raw token: %s", key)
	}
	if key != BlacklistKey(token) {
		t.Fatal("blacklist key is not deterministic")
	}
}
