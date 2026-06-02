package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/zstrategy/backend/internal/domain"
)

type EnclaveClient interface {
	Metadata(ctx context.Context) (*EnclaveMetadata, error)
	Attest(ctx context.Context, req AttestationRequest) (map[string]any, error)
	ImportPackage(ctx context.Context, pkg domain.EncryptedWitnessPackage) error
	Evaluate(ctx context.Context, commitmentHash string, fillCtx domain.FillContext) (*domain.ExecutionTicket, bool, error)
	Prune(ctx context.Context, commitmentHash string) error
}

type EnclaveMetadata struct {
	Mode             string            `json:"mode"`
	RootPublicKeyPem string            `json:"rootPublicKeyPem"`
	ImageDigest      string            `json:"imageDigest"`
	PCRs             map[string]string `json:"pcrs"`
}

type AttestationRequest struct {
	Nonce    string `json:"nonce"`
	UserData string `json:"userData,omitempty"`
}

type HTTPEnclaveClient struct {
	baseURL   string
	apiSecret string
	client    *http.Client
}

type EnclaveHTTPError struct {
	Method     string
	Path       string
	StatusCode int
	Message    string
}

func (e *EnclaveHTTPError) Error() string {
	return fmt.Sprintf("enclave %s %s returned %d: %s", e.Method, e.Path, e.StatusCode, e.Message)
}

func NewHTTPEnclaveClient(baseURL, apiSecret string) *HTTPEnclaveClient {
	return &HTTPEnclaveClient{
		baseURL:   strings.TrimRight(baseURL, "/"),
		apiSecret: apiSecret,
		client:    &http.Client{Timeout: 3 * time.Minute},
	}
}

func (c *HTTPEnclaveClient) Metadata(ctx context.Context) (*EnclaveMetadata, error) {
	var out EnclaveMetadata
	if err := c.do(ctx, http.MethodGet, "/metadata", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *HTTPEnclaveClient) Attest(ctx context.Context, req AttestationRequest) (map[string]any, error) {
	var out map[string]any
	if err := c.do(ctx, http.MethodPost, "/attest", req, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *HTTPEnclaveClient) ImportPackage(ctx context.Context, pkg domain.EncryptedWitnessPackage) error {
	var out map[string]any
	return c.do(ctx, http.MethodPost, "/packages", pkg, &out)
}

func (c *HTTPEnclaveClient) Evaluate(ctx context.Context, commitmentHash string, fillCtx domain.FillContext) (*domain.ExecutionTicket, bool, error) {
	var out struct {
		Status string                  `json:"status"`
		Ticket *domain.ExecutionTicket `json:"ticket"`
	}
	err := c.do(ctx, http.MethodPost, "/evaluate", map[string]any{
		"commitmentHash": commitmentHash,
		"context":        fillCtx,
	}, &out)
	if err != nil {
		return nil, false, err
	}
	if out.Status == "NOT_READY" {
		return nil, false, nil
	}
	if out.Status != "READY" || out.Ticket == nil {
		return nil, false, fmt.Errorf("unexpected enclave evaluate response: %q", out.Status)
	}
	return out.Ticket, true, nil
}

func (c *HTTPEnclaveClient) Prune(ctx context.Context, commitmentHash string) error {
	var out map[string]any
	return c.do(ctx, http.MethodDelete, "/packages/"+commitmentHash, nil, &out)
}

func (c *HTTPEnclaveClient) do(ctx context.Context, method, path string, body, out any) error {
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal enclave request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("build enclave request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiSecret != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiSecret)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("enclave %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errBody struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&errBody)
		if errBody.Error == "" {
			errBody.Error = resp.Status
		}
		return &EnclaveHTTPError{
			Method:     method,
			Path:       path,
			StatusCode: resp.StatusCode,
			Message:    errBody.Error,
		}
	}

	if out == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode enclave response: %w", err)
	}
	return nil
}
