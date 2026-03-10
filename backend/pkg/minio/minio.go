package minio

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type Client struct {
	client         *minio.Client
	bucket         string
	publicEndpoint string
	internalHost   string
}

func New(endpoint, accessKey, secretKey, bucket string, useSSL bool, publicEndpoint string) (*Client, error) {
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(accessKey, secretKey, ""),
		Secure: useSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("minio connect error: %w", err)
	}

	ctx := context.Background()
	exists, err := client.BucketExists(ctx, bucket)
	if err != nil {
		return nil, fmt.Errorf("minio check bucket error: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("minio create bucket error: %w", err)
		}
	}

	// Extract internal host for URL rewriting (e.g. "minio:9000")
	internalHost := endpoint

	return &Client{
		client:         client,
		bucket:         bucket,
		publicEndpoint: publicEndpoint,
		internalHost:   internalHost,
	}, nil
}

func (c *Client) Upload(ctx context.Context, objectKey string, reader io.Reader, size int64, contentType string) error {
	_, err := c.client.PutObject(ctx, c.bucket, objectKey, reader, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	return err
}

func (c *Client) GetObject(ctx context.Context, objectKey string) (*minio.Object, error) {
	object, err := c.client.GetObject(ctx, c.bucket, objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}

	if _, err := object.Stat(); err != nil {
		_ = object.Close()
		return nil, err
	}

	return object, nil
}

func (c *Client) GetPresignedURL(ctx context.Context, objectKey string, expires time.Duration) (string, error) {
	url, err := c.client.PresignedGetObject(ctx, c.bucket, objectKey, expires, nil)
	if err != nil {
		return "", err
	}

	rawURL := url.String()

	// Rewrite internal hostname to public endpoint if configured
	if c.publicEndpoint != "" && c.internalHost != "" {
		scheme := "http://"
		if strings.HasPrefix(rawURL, "https://") {
			scheme = "https://"
		}
		internalPrefix := scheme + c.internalHost
		if strings.HasPrefix(rawURL, internalPrefix) {
			rawURL = scheme + c.publicEndpoint + rawURL[len(internalPrefix):]
		}
	}

	return rawURL, nil
}

func (c *Client) Delete(ctx context.Context, objectKey string) error {
	return c.client.RemoveObject(ctx, c.bucket, objectKey, minio.RemoveObjectOptions{})
}
