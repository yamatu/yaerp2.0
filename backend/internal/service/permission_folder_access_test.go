package service

import (
	"errors"
	"testing"

	"yaerp/internal/model"
)

func TestResolveFolderAccessFromPath(t *testing.T) {
	const (
		rootID   = int64(10)
		midID    = int64(11)
		targetID = int64(12)
		otherID  = int64(99)
	)
	// Parent ids are taken from variables so their addresses can be referenced.
	midParent := midID
	const (
		owner         = int64(1)
		stranger      = int64(2)
		sharedViewer  = int64(3)
		sharedEditor  = int64(4)
		ancestorOwner = int64(5)
		roleVisible   = int64(6)
	)

	folder := func(id int64, parent *int64, ownerID int64) model.Folder {
		return model.Folder{ID: id, ParentID: parent, OwnerID: ownerID}
	}
	rootFolder := folder(rootID, nil, otherID)
	midFolder := folder(midID, &midParent, otherID)
	targetFolder := folder(targetID, &midParent, otherID)
	goalPath := []model.Folder{rootFolder, midFolder, targetFolder}

	newShareLookup := func(levels map[int64]string, calls *[]int64) func(int64) (string, error) {
		return func(folderID int64) (string, error) {
			if calls != nil {
				*calls = append(*calls, folderID)
			}
			return levels[folderID], nil
		}
	}

	noAccess := folderAccessResult{AccessLevel: "", CanView: false, CanWrite: false, CanManage: false}

	cases := []struct {
		name             string
		folderID         int64
		userID           int64
		path             []model.Folder
		visible          map[int64]bool
		shares           map[int64]string
		want             folderAccessResult
		wantShareLookups []int64
	}{
		{
			name:     "owner of the folder can manage it",
			folderID: targetID,
			userID:   owner,
			path:     []model.Folder{rootFolder, midFolder, folder(targetID, &midParent, owner)},
			want:     folderAccessResult{AccessLevel: "owner", CanView: true, CanWrite: true, CanManage: true},
			// Root and mid are still consulted for shares; the owned folder is not.
			wantShareLookups: []int64{rootID, midID},
		},
		{
			name:     "owner of an ancestor may edit but not manage",
			folderID: targetID,
			userID:   ancestorOwner,
			path:     []model.Folder{rootFolder, folder(midID, &midParent, ancestorOwner), targetFolder},
			want:     folderAccessResult{AccessLevel: "edit", CanView: true, CanWrite: true, CanManage: false},
			// The owned ancestor short-circuits its share lookup.
			wantShareLookups: []int64{rootID, targetID},
		},
		{
			name:     "edit share on an ancestor grants write on the folder",
			folderID: targetID,
			userID:   sharedEditor,
			path:     goalPath,
			shares:   map[int64]string{midID: "edit"},
			want:     folderAccessResult{AccessLevel: "edit", CanView: true, CanWrite: true, CanManage: false},
		},
		{
			name:     "view share on an ancestor only grants read",
			folderID: targetID,
			userID:   sharedViewer,
			path:     goalPath,
			shares:   map[int64]string{rootID: "view"},
			want:     folderAccessResult{AccessLevel: "view", CanView: true, CanWrite: false, CanManage: false},
		},
		{
			name:     "view share on the folder itself only grants read",
			folderID: targetID,
			userID:   sharedViewer,
			path:     goalPath,
			shares:   map[int64]string{targetID: "view"},
			want:     folderAccessResult{AccessLevel: "view", CanView: true, CanWrite: false, CanManage: false},
		},
		{
			name:     "role visibility of the folder itself grants read",
			folderID: targetID,
			userID:   roleVisible,
			path:     goalPath,
			visible:  map[int64]bool{targetID: true},
			want:     folderAccessResult{AccessLevel: "view", CanView: true, CanWrite: false, CanManage: false},
		},
		{
			name:     "role visibility of an ancestor does not leak down",
			folderID: targetID,
			userID:   roleVisible,
			path:     goalPath,
			visible:  map[int64]bool{rootID: true, midID: true},
			want:     noAccess,
		},
		{
			name:             "unrelated account sees nothing",
			folderID:         targetID,
			userID:           stranger,
			path:             goalPath,
			want:             noAccess,
			wantShareLookups: []int64{rootID, midID, targetID},
		},
		{
			name:     "manage stays limited to the requested folder",
			folderID: targetID,
			userID:   owner,
			path:     []model.Folder{{ID: otherID, OwnerID: owner}},
			want:     folderAccessResult{AccessLevel: "edit", CanView: true, CanWrite: true, CanManage: false},
		},
		{
			name:             "empty path means no access",
			folderID:         targetID,
			userID:           owner,
			path:             nil,
			want:             noAccess,
			wantShareLookups: []int64{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls []int64
			got, err := resolveFolderAccessFromPath(
				tc.folderID,
				tc.userID,
				tc.path,
				tc.visible,
				newShareLookup(tc.shares, &calls),
			)
			if err != nil {
				t.Fatalf("resolveFolderAccessFromPath returned error: %v", err)
			}
			if got == nil {
				t.Fatal("expected a result, got nil")
			}
			if *got != tc.want {
				t.Fatalf("access = %+v, want %+v", *got, tc.want)
			}
			if tc.wantShareLookups != nil {
				if len(calls) != len(tc.wantShareLookups) {
					t.Fatalf("share lookups = %v, want %v", calls, tc.wantShareLookups)
				}
				for i, want := range tc.wantShareLookups {
					if calls[i] != want {
						t.Fatalf("share lookups = %v, want %v", calls, tc.wantShareLookups)
					}
				}
			}
		})
	}
}

func TestResolveFolderAccessFromPathPropagatesShareErrors(t *testing.T) {
	boom := errors.New("share lookup failed")
	_, err := resolveFolderAccessFromPath(12, 1, []model.Folder{{ID: 12, OwnerID: 2}}, nil, func(int64) (string, error) {
		return "", boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}
