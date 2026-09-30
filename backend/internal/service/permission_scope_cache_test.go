package service

import (
	"errors"
	"testing"
	"yaerp/internal/model"
)

func TestPermissionMatricesCachedOnlyWithinOperationAndUser(t *testing.T) {
	calls := 0
	s := &PermissionService{sheetOverride: func(userID, sheetID int64) (bool, *model.PermissionMatrix, error) {
		calls++
		return true, fullAccessMatrix(), nil
	}}
	cache := &permissionLookupCache{roles: map[int64][]model.Role{1: {}, 2: {}}}
	first, err := s.getPermissionMatrixCached(5, 1, cache)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.getPermissionMatrixCached(5, 1, cache)
	if err != nil || second != first || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
	if _, err := s.getPermissionMatrixCached(5, 2, cache); err != nil || calls != 2 {
		t.Fatalf("cache must not cross users: calls=%d err=%v", calls, err)
	}
	fresh := &permissionLookupCache{roles: map[int64][]model.Role{1: {}}}
	if _, err := s.getPermissionMatrixCached(5, 1, fresh); err != nil || calls != 3 {
		t.Fatalf("cache must not cross operations: calls=%d err=%v", calls, err)
	}
}

func TestPermissionMatrixLookupErrorsAreNotCached(t *testing.T) {
	calls := 0
	want := errors.New("database temporarily unavailable")
	s := &PermissionService{sheetOverride: func(userID, sheetID int64) (bool, *model.PermissionMatrix, error) {
		calls++
		if calls == 1 {
			return true, nil, want
		}
		return true, fullAccessMatrix(), nil
	}}
	cache := &permissionLookupCache{roles: map[int64][]model.Role{1: {}}}
	if _, err := s.getPermissionMatrixCached(5, 1, cache); !errors.Is(err, want) {
		t.Fatalf("%v", err)
	}
	if _, err := s.getPermissionMatrixCached(5, 1, cache); err != nil || calls != 2 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}
