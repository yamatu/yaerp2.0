package service

import (
	"encoding/base64"
	"testing"

	"yaerp/internal/model"
)

func TestValidateChannelBackupSnapshot(t *testing.T) {
	attachmentID := int64(7)
	snapshot := &channelBackupSnapshot{
		Version: channelBackupVersion,
		Messages: []channelBackupMessage{{
			OriginalID:     12,
			ChannelMessage: model.ChannelMessage{AttachmentID: &attachmentID},
		}},
		Files: []channelBackupAttachment{{
			OriginalID: attachmentID,
			Filename:   "image.png",
			MimeType:   "image/png",
			Data:       base64.StdEncoding.EncodeToString([]byte("valid-image-data")),
		}},
	}
	files, err := validateChannelBackupSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if string(files[attachmentID]) != "valid-image-data" {
		t.Fatal("decoded attachment data mismatch")
	}
}

func TestValidateChannelBackupSnapshotRejectsMissingAttachment(t *testing.T) {
	attachmentID := int64(99)
	snapshot := &channelBackupSnapshot{
		Version: channelBackupVersion,
		Messages: []channelBackupMessage{{
			OriginalID:     1,
			ChannelMessage: model.ChannelMessage{AttachmentID: &attachmentID},
		}},
	}
	if _, err := validateChannelBackupSnapshot(snapshot); err == nil {
		t.Fatal("expected missing attachment validation error")
	}
}
