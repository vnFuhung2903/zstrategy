package http

import (
	"bytes"
	"context"
	"encoding/json"
	stdhttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/zstrategy/backend/internal/domain"
	"github.com/zstrategy/backend/internal/service"
)

type handlerIntentRepo struct {
	saved       []*domain.PendingIntent
	batchSaved  []*domain.PendingIntent
	ticketReady []*domain.PendingIntent
}

func (r *handlerIntentRepo) Save(_ context.Context, intent *domain.PendingIntent) error {
	r.saved = append(r.saved, intent)
	return nil
}

func (r *handlerIntentRepo) SaveBatch(_ context.Context, intents []*domain.PendingIntent) error {
	r.batchSaved = append(r.batchSaved, intents...)
	return nil
}

func (r *handlerIntentRepo) GetByHash(_ context.Context, commitmentHash string) (*domain.PendingIntent, error) {
	for _, intent := range r.ticketReady {
		if intent.CommitmentHash == commitmentHash {
			return intent, nil
		}
	}
	return nil, nil
}

func (r *handlerIntentRepo) UpdateStatus(_ context.Context, commitmentHash string, status domain.IntentStatus) error {
	for _, intent := range r.ticketReady {
		if intent.CommitmentHash == commitmentHash {
			intent.Status = status
			return nil
		}
	}
	return nil
}

func (r *handlerIntentRepo) ClaimForEvaluation(context.Context, string) (bool, error) {
	return false, nil
}

func (r *handlerIntentRepo) StoreTicket(context.Context, string, string, time.Time) (bool, error) {
	return false, nil
}

func (r *handlerIntentRepo) ClaimTicketLease(_ context.Context, commitmentHash, leasedBy string, now, leaseExpiresAt time.Time) (bool, error) {
	for _, intent := range r.ticketReady {
		if intent.CommitmentHash != commitmentHash ||
			intent.Status != domain.IntentTicketReady ||
			intent.TicketExpiresAt == nil ||
			!intent.TicketExpiresAt.After(now) {
			continue
		}
		if intent.LeaseExpiresAt != nil && intent.LeaseExpiresAt.After(now) && !strings.EqualFold(intent.LeasedBy, leasedBy) {
			return false, nil
		}
		intent.LeasedBy = leasedBy
		intent.LeaseExpiresAt = &leaseExpiresAt
		return true, nil
	}
	return false, nil
}

func (r *handlerIntentRepo) MarkFailed(context.Context, string, string) (bool, error) {
	return false, nil
}

func (r *handlerIntentRepo) ResetEvaluation(context.Context, string) (bool, error) {
	return false, nil
}

func (r *handlerIntentRepo) ResetTicket(_ context.Context, commitmentHash, reason string) (bool, error) {
	for _, intent := range r.ticketReady {
		if intent.CommitmentHash != commitmentHash || intent.Status != domain.IntentTicketReady {
			continue
		}
		intent.Status = domain.IntentPending
		intent.Ticket = "null"
		intent.TicketExpiresAt = nil
		intent.LeasedBy = ""
		intent.LeaseExpiresAt = nil
		intent.LastError = reason
		return true, nil
	}
	return false, nil
}

func (r *handlerIntentRepo) ListPending(context.Context) ([]*domain.PendingIntent, error) {
	return nil, nil
}

func (r *handlerIntentRepo) ListTicketReady(context.Context) ([]*domain.PendingIntent, error) {
	return r.ticketReady, nil
}

func (r *handlerIntentRepo) CountByStatus(context.Context, domain.IntentStatus) (int64, error) {
	return 0, nil
}

func (r *handlerIntentRepo) CountByKindsAndStatuses(_ context.Context, chainID int64, kinds []domain.IntentKind, statuses []domain.IntentStatus) (int64, error) {
	kindSet := make(map[domain.IntentKind]bool, len(kinds))
	for _, kind := range kinds {
		kindSet[kind] = true
	}
	statusSet := make(map[domain.IntentStatus]bool, len(statuses))
	for _, status := range statuses {
		statusSet[status] = true
	}
	var n int64
	for _, intent := range append(r.saved, r.batchSaved...) {
		if intent.ChainID == chainID && kindSet[intent.Kind] && statusSet[intent.Status] {
			n++
		}
	}
	for _, intent := range r.ticketReady {
		if intent.ChainID == chainID && kindSet[intent.Kind] && statusSet[intent.Status] {
			n++
		}
	}
	return n, nil
}

func (r *handlerIntentRepo) ResetStuckExecuting(context.Context, time.Duration) ([]*domain.PendingIntent, error) {
	return nil, nil
}

func (r *handlerIntentRepo) ResetExpiredTickets(context.Context, time.Time) ([]*domain.PendingIntent, error) {
	return nil, nil
}

func newClaimRouter(repo *handlerIntentRepo, fn func(context.Context, string, domain.ExecutionTicket) (service.TicketClaimCheck, error)) stdhttp.Handler {
	h := NewHandler(nil, nil, repo, nil, nil, "")
	h.validateClaimFn = fn
	return NewRouter(h, false)
}

func executableClaim(context.Context, string, domain.ExecutionTicket) (service.TicketClaimCheck, error) {
	return service.TicketClaimCheck{Executable: true, CommitmentPending: true}, nil
}

func TestRegisterOrderIntentRejectsPlaintextWitnessFields(t *testing.T) {
	repo := &handlerIntentRepo{}
	router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)
	body := map[string]any{
		"commitmentHash": hash("01"),
		"kind":           "LIMIT",
		"chainId":        int64(421614),
		"tokenIn":        addr("11"),
		"tokenOut":       addr("22"),
		"size":           "100",
		"minOut":         "90",
		"expiry":         int64(1700000000),
		"limitPrice":     "1000",
		"witnessPackage": testWitnessPackage(t, domain.CircuitKindOrderFill, hash("01"), "100", "90", 1700000000),
	}

	rec := postJSON(router, "/api/v1/intents/order", body)
	if rec.Code != stdhttp.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusBadRequest, rec.Body.String())
	}
	if len(repo.saved) != 0 {
		t.Fatalf("saved %d intents, want 0", len(repo.saved))
	}
}

func TestRegisterOrderIntentStoresEncryptedWitnessPackageOnly(t *testing.T) {
	repo := &handlerIntentRepo{}
	router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)
	body := map[string]any{
		"commitmentHash": hash("02"),
		"kind":           "MARKET",
		"chainId":        int64(421614),
		"tokenIn":        addr("11"),
		"tokenOut":       addr("22"),
		"size":           "100",
		"minOut":         "90",
		"expiry":         int64(1700000000),
		"witnessPackage": testWitnessPackage(t, domain.CircuitKindOrderFill, hash("02"), "100", "90", 1700000000),
	}

	rec := postJSON(router, "/api/v1/intents/order", body)
	if rec.Code != stdhttp.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusCreated, rec.Body.String())
	}
	if len(repo.saved) != 1 {
		t.Fatalf("saved %d intents, want 1", len(repo.saved))
	}
	got := repo.saved[0]
	if got.Kind != domain.KindMarket {
		t.Fatalf("kind = %s, want MARKET", got.Kind)
	}
	if got.WitnessPackage == "" || got.Registry == "" {
		t.Fatalf("witness package/registry not stored: %#v", got)
	}
}

func TestRegisterDcaIntentRejectsRoundPlaintextWitnessFields(t *testing.T) {
	repo := &handlerIntentRepo{}
	router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)
	body := map[string]any{
		"chainId":        int64(421614),
		"dcaGroupLockId": hash("bb"),
		"tokenIn":        addr("11"),
		"tokenOut":       addr("22"),
		"rounds": []map[string]any{{
			"commitmentHash": hash("03"),
			"size":           "100",
			"minOut":         "0",
			"expiry":         int64(1700000100),
			"roundIndex":     0,
			"scheduledLo":    int64(1700000000),
			"witnessPackage": testWitnessPackage(t, domain.CircuitKindDCA, hash("03"), "100", "0", 1700000100, hash("bb")),
		}},
	}

	rec := postJSON(router, "/api/v1/intents/dca", body)
	if rec.Code != stdhttp.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusBadRequest, rec.Body.String())
	}
	if len(repo.batchSaved) != 0 {
		t.Fatalf("batch saved %d intents, want 0", len(repo.batchSaved))
	}
}

func TestRegisterDcaIntentSavesEncryptedPackagesInOneBatch(t *testing.T) {
	repo := &handlerIntentRepo{}
	router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)
	dcaGroupLockID := hash("bb")
	body := map[string]any{
		"chainId":        int64(421614),
		"dcaGroupLockId": dcaGroupLockID,
		"tokenIn":        addr("11"),
		"tokenOut":       addr("22"),
		"rounds": []map[string]any{{
			"commitmentHash": hash("04"),
			"size":           "100",
			"minOut":         "0",
			"expiry":         int64(1700000100),
			"roundIndex":     0,
			"witnessPackage": testWitnessPackage(t, domain.CircuitKindDCA, hash("04"), "100", "0", 1700000100, dcaGroupLockID),
		}, {
			"commitmentHash": hash("05"),
			"size":           "100",
			"minOut":         "0",
			"expiry":         int64(1700000200),
			"roundIndex":     1,
			"witnessPackage": testWitnessPackage(t, domain.CircuitKindDCA, hash("05"), "100", "0", 1700000200, dcaGroupLockID),
		}},
	}

	rec := postJSON(router, "/api/v1/intents/dca", body)
	if rec.Code != stdhttp.StatusCreated {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusCreated, rec.Body.String())
	}
	if len(repo.batchSaved) != 2 {
		t.Fatalf("batch saved %d intents, want 2", len(repo.batchSaved))
	}
	for _, saved := range repo.batchSaved {
		if saved.WitnessPackage == "" {
			t.Fatalf("empty witness package in saved intent")
		}
		if saved.DCAGroupLockID != dcaGroupLockID {
			t.Fatalf("dca group lock = %s, want %s", saved.DCAGroupLockID, dcaGroupLockID)
		}
	}
}

func TestRegisterDcaIntentRejectsRawDcaGroupID(t *testing.T) {
	repo := &handlerIntentRepo{}
	router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)
	body := map[string]any{
		"chainId":    int64(421614),
		"dcaGroupId": hash("bb"),
		"tokenIn":    addr("11"),
		"tokenOut":   addr("22"),
		"rounds":     []map[string]any{},
	}

	rec := postJSON(router, "/api/v1/intents/dca", body)
	if rec.Code != stdhttp.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusBadRequest, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "raw DCA group identifier") {
		t.Fatalf("body = %s, want raw group rejection", rec.Body.String())
	}
}

func TestRegisterDcaIntentRejectsMismatchedDcaGroupLockPackage(t *testing.T) {
	repo := &handlerIntentRepo{}
	router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)
	body := map[string]any{
		"chainId":        int64(421614),
		"dcaGroupLockId": hash("bb"),
		"tokenIn":        addr("11"),
		"tokenOut":       addr("22"),
		"rounds": []map[string]any{{
			"commitmentHash": hash("15"),
			"size":           "100",
			"minOut":         "0",
			"expiry":         int64(1700000100),
			"roundIndex":     0,
			"witnessPackage": testWitnessPackage(t, domain.CircuitKindDCA, hash("15"), "100", "0", 1700000100, hash("cc")),
		}},
	}

	rec := postJSON(router, "/api/v1/intents/dca", body)
	if rec.Code != stdhttp.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusBadRequest, rec.Body.String())
	}
	if len(repo.batchSaved) != 0 {
		t.Fatalf("batch saved %d intents, want 0", len(repo.batchSaved))
	}
}

func TestListExecutionTicketsReturnsOnlyUnexpiredTicketsWithoutWitnessPackage(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("06"), 421614, time.Minute)
	expired := testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("07"), 421614, -time.Minute)
	otherChain := testTicketReadyIntent(t, domain.KindDCA, domain.CircuitKindDCA, hash("08"), 84532, time.Minute)
	pending := testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("09"), 421614, time.Minute)
	pending.Status = domain.IntentPending
	leased := testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("17"), 421614, time.Minute)
	leaseExpiry := time.Now().Add(time.Minute)
	leased.LeasedBy = addr("ee")
	leased.LeaseExpiresAt = &leaseExpiry
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready, expired, otherChain, pending, leased}}
	router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)

	rec := get(router, "/api/v1/executor/tickets?chain_id=421614")
	if rec.Code != stdhttp.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusOK, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "witnessPackage") || strings.Contains(rec.Body.String(), "ciphertext") {
		t.Fatalf("ticket response leaked witness package: %s", rec.Body.String())
	}

	var body struct {
		Data []executionTicketResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Data) != 1 {
		t.Fatalf("tickets = %d, want 1; body=%s", len(body.Data), rec.Body.String())
	}
	if body.Data[0].CommitmentHash != ready.CommitmentHash {
		t.Fatalf("commitment hash = %s, want %s", body.Data[0].CommitmentHash, ready.CommitmentHash)
	}
	if body.Data[0].Ticket.Proof == "" || body.Data[0].Ticket.Nullifier == "" {
		t.Fatalf("ticket missing execution fields: %#v", body.Data[0].Ticket)
	}
}

func TestListExecutionTicketsFiltersMalformedTickets(t *testing.T) {
	tests := []struct {
		name   string
		intent *domain.PendingIntent
		mutate func(*domain.ExecutionTicket)
	}{
		{
			name:   "limit with dca ticket",
			intent: testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("0b"), 421614, time.Minute),
			mutate: func(ticket *domain.ExecutionTicket) {
				ticket.Kind = domain.CircuitKindDCA
				ticket.FillRef = "1700000000"
			},
		},
		{
			name:   "dca with order fill ticket",
			intent: testTicketReadyIntent(t, domain.KindDCA, domain.CircuitKindDCA, hash("0c"), 421614, time.Minute),
			mutate: func(ticket *domain.ExecutionTicket) {
				ticket.Kind = domain.CircuitKindOrderFill
				ticket.FillRef = "0"
			},
		},
		{
			name:   "order fill nonzero fill ref",
			intent: testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("0d"), 421614, time.Minute),
			mutate: func(ticket *domain.ExecutionTicket) {
				ticket.FillRef = "123"
			},
		},
		{
			name:   "dca invalid fill ref",
			intent: testTicketReadyIntent(t, domain.KindDCA, domain.CircuitKindDCA, hash("0e"), 421614, time.Minute),
			mutate: func(ticket *domain.ExecutionTicket) {
				ticket.FillRef = "not-a-number"
			},
		},
		{
			name:   "commitment mismatch",
			intent: testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("0f"), 421614, time.Minute),
			mutate: func(ticket *domain.ExecutionTicket) {
				ticket.CommitmentHash = hash("10")
			},
		},
		{
			name:   "missing package hash",
			intent: testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("11"), 421614, time.Minute),
			mutate: func(ticket *domain.ExecutionTicket) {
				ticket.PackageHash = ""
			},
		},
		{
			name:   "missing prover receipt",
			intent: testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("12"), 421614, time.Minute),
			mutate: func(ticket *domain.ExecutionTicket) {
				ticket.ProverReceipt = domain.ProverReceipt{}
			},
		},
		{
			name:   "prover receipt mismatch",
			intent: testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("13"), 421614, time.Minute),
			mutate: func(ticket *domain.ExecutionTicket) {
				ticket.ProverReceipt.ProverID = hash("14")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			replaceStoredTicket(t, tt.intent, tt.mutate)
			repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{tt.intent}}
			router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)

			rec := get(router, "/api/v1/executor/tickets?chain_id=421614")
			if rec.Code != stdhttp.StatusOK {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusOK, rec.Body.String())
			}

			var body struct {
				Data []executionTicketResponse `json:"data"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if len(body.Data) != 0 {
				t.Fatalf("tickets = %d, want 0; body=%s", len(body.Data), rec.Body.String())
			}
		})
	}
}

func TestExecutionTicketEndpointsDoNotExposePrivateFields(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hash("12"), 421614, time.Minute)
	var raw map[string]any
	if err := json.Unmarshal([]byte(ready.Ticket), &raw); err != nil {
		t.Fatalf("decode ticket: %v", err)
	}
	raw["price"] = "123"
	raw["direction"] = 1
	raw["nonce"] = hash("13")
	raw["user_secret"] = hash("14")
	raw["userSecret"] = hash("15")
	raw["scheduledLo"] = 1700000000
	raw["scheduledHi"] = 1700000300
	raw["dcaGroupId"] = hash("16")
	raw["dcaGroupLockId"] = hash("17")
	raw["witnessPackage"] = map[string]any{"ciphertext": "0xprivate"}
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("encode ticket: %v", err)
	}
	ready.Ticket = string(encoded)

	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready}}
	router := NewRouter(NewHandler(nil, nil, repo, nil, nil, ""), false)

	rec := get(router, "/api/v1/executor/tickets?chain_id=421614")
	if rec.Code != stdhttp.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusOK, rec.Body.String())
	}
	body := strings.ToLower(rec.Body.String())
	for _, forbidden := range []string{
		"witnesspackage",
		"ciphertext",
		"price",
		"direction",
		"nonce",
		"user_secret",
		"usersecret",
		"scheduledlo",
		"scheduledhi",
		"dcagroupid",
		"dcagrouplockid",
	} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("ticket response leaked %q: %s", forbidden, rec.Body.String())
		}
	}
}

func TestClaimExecutionTicketReturnsAndLeasesFirstReadyTicket(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindDCA, domain.CircuitKindDCA, hash("0a"), 421614, time.Minute)
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready}}
	router := newClaimRouter(repo, executableClaim)

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{"executor": addr("ee")})
	if rec.Code != stdhttp.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusOK, rec.Body.String())
	}

	var body struct {
		Data executionTicketResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Data.CommitmentHash != ready.CommitmentHash {
		t.Fatalf("commitment hash = %s, want %s", body.Data.CommitmentHash, ready.CommitmentHash)
	}
	if body.Data.Ticket.Kind != domain.CircuitKindDCA {
		t.Fatalf("circuit kind = %s, want DCA", body.Data.Ticket.Kind)
	}
	if body.Data.LeasedBy != strings.ToLower(addr("ee")) || body.Data.LeaseExpiresAt == 0 {
		t.Fatalf("lease fields not returned: %#v", body.Data)
	}
	if ready.LeasedBy != strings.ToLower(addr("ee")) || ready.LeaseExpiresAt == nil {
		t.Fatalf("intent was not leased: %#v", ready)
	}
}

func TestClaimExecutionTicketCanTargetSelectedCommitment(t *testing.T) {
	first := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("1d"), 421614, time.Minute)
	second := testTicketReadyIntent(t, domain.KindDCA, domain.CircuitKindDCA, hash("1e"), 421614, time.Minute)
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{first, second}}
	router := newClaimRouter(repo, executableClaim)

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{
		"executor":       addr("ee"),
		"commitmentHash": second.CommitmentHash,
	})
	if rec.Code != stdhttp.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusOK, rec.Body.String())
	}

	var body struct {
		Data executionTicketResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Data.CommitmentHash != second.CommitmentHash {
		t.Fatalf("claimed hash = %s, want selected %s", body.Data.CommitmentHash, second.CommitmentHash)
	}
	if first.LeaseExpiresAt != nil {
		t.Fatalf("first ticket was leased unexpectedly: %#v", first)
	}
	if second.LeasedBy != strings.ToLower(addr("ee")) || second.LeaseExpiresAt == nil {
		t.Fatalf("selected ticket was not leased: %#v", second)
	}
}

func TestClaimExecutionTicketCanTargetCommitmentOutsideQueueLimit(t *testing.T) {
	first := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("20"), 421614, time.Minute)
	second := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("21"), 421614, time.Minute)
	target := testTicketReadyIntent(t, domain.KindDCA, domain.CircuitKindDCA, hash("22"), 421614, time.Minute)
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{first, second, target}}
	router := newClaimRouter(repo, executableClaim)

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614&limit=1", map[string]any{
		"executor":       addr("ee"),
		"commitmentHash": target.CommitmentHash,
	})
	if rec.Code != stdhttp.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusOK, rec.Body.String())
	}

	var body struct {
		Data executionTicketResponse `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Data.CommitmentHash != target.CommitmentHash {
		t.Fatalf("claimed hash = %s, want selected %s", body.Data.CommitmentHash, target.CommitmentHash)
	}
	if first.LeaseExpiresAt != nil || second.LeaseExpiresAt != nil {
		t.Fatalf("non-target tickets were leased unexpectedly: %#v %#v", first, second)
	}
	if target.LeasedBy != strings.ToLower(addr("ee")) || target.LeaseExpiresAt == nil {
		t.Fatalf("target ticket was not leased: %#v", target)
	}
}

func TestClaimExecutionTicketLeasePreventsDuplicateExecutorClaims(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("16"), 421614, time.Minute)
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready}}
	router := newClaimRouter(repo, executableClaim)

	first := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{"executor": addr("ee")})
	second := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{"executor": addr("dd")})
	if first.Code != stdhttp.StatusOK || second.Code != stdhttp.StatusNotFound {
		t.Fatalf("claim statuses = %d/%d, want 200/404", first.Code, second.Code)
	}
	if ready.Status != domain.IntentTicketReady {
		t.Fatalf("status = %s, want TICKET_READY", ready.Status)
	}
	if ready.LeaseExpiresAt == nil {
		t.Fatalf("lease was not recorded")
	}
}

func TestClaimExecutionTicketAllowsSameExecutorToReclaimLease(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("18"), 421614, time.Minute)
	leaseExpiry := time.Now().Add(time.Minute)
	ready.LeasedBy = strings.ToLower(addr("ee"))
	ready.LeaseExpiresAt = &leaseExpiry
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready}}
	router := newClaimRouter(repo, executableClaim)

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{"executor": addr("ee")})
	if rec.Code != stdhttp.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusOK, rec.Body.String())
	}
}

func TestClaimExecutionTicketRequiresExecutorForSimulation(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("19"), 421614, time.Minute)
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready}}
	router := newClaimRouter(repo, executableClaim)

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{})
	if rec.Code != stdhttp.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusBadRequest, rec.Body.String())
	}
	if ready.LeaseExpiresAt != nil {
		t.Fatalf("ticket was leased without executor")
	}
}

func TestClaimExecutionTicketRejectsQueryOnlyExecutor(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("1c"), 421614, time.Minute)
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready}}
	router := newClaimRouter(repo, executableClaim)

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614&executor="+addr("ee"), map[string]any{})
	if rec.Code != stdhttp.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusBadRequest, rec.Body.String())
	}
	if ready.LeaseExpiresAt != nil {
		t.Fatalf("ticket was leased from query-only executor")
	}
}

func TestClaimExecutionTicketResetsPendingTicketWhenSimulationFails(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("1a"), 421614, time.Minute)
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready}}
	router := newClaimRouter(repo, func(context.Context, string, domain.ExecutionTicket) (service.TicketClaimCheck, error) {
		return service.TicketClaimCheck{
			Executable:        false,
			CommitmentPending: true,
			Reason:            "execution reverted",
		}, nil
	})

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{"executor": addr("ee")})
	if rec.Code != stdhttp.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "execution reverted") {
		t.Fatalf("body = %s, want simulation reason", rec.Body.String())
	}
	if ready.Status != domain.IntentPending {
		t.Fatalf("status = %s, want PENDING", ready.Status)
	}
	if ready.Ticket != "null" || ready.TicketExpiresAt != nil || ready.LeaseExpiresAt != nil || ready.LeasedBy != "" {
		t.Fatalf("ticket fields were not cleared: %#v", ready)
	}
	if !strings.Contains(ready.LastError, "claim simulation failed") {
		t.Fatalf("last error = %q, want claim simulation reason", ready.LastError)
	}
}

func TestClaimExecutionTicketMarksFinalizedTicketDoneWhenSimulationFails(t *testing.T) {
	ready := testTicketReadyIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hash("1b"), 421614, time.Minute)
	repo := &handlerIntentRepo{ticketReady: []*domain.PendingIntent{ready}}
	router := newClaimRouter(repo, func(context.Context, string, domain.ExecutionTicket) (service.TicketClaimCheck, error) {
		return service.TicketClaimCheck{
			Executable:        false,
			CommitmentPending: false,
			Reason:            "Registry: not pending",
		}, nil
	})

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{"executor": addr("ee")})
	if rec.Code != stdhttp.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusConflict, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Registry: not pending") {
		t.Fatalf("body = %s, want simulation reason", rec.Body.String())
	}
	if ready.Status != domain.IntentDone {
		t.Fatalf("status = %s, want DONE", ready.Status)
	}
}

func TestClaimExecutionTicketReturnsNotFoundWhenQueueEmpty(t *testing.T) {
	repo := &handlerIntentRepo{}
	router := newClaimRouter(repo, executableClaim)

	rec := postJSON(router, "/api/v1/executor/tickets/claim?chain_id=421614", map[string]any{"executor": addr("ee")})
	if rec.Code != stdhttp.StatusNotFound {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, stdhttp.StatusNotFound, rec.Body.String())
	}
}

func replaceStoredTicket(t *testing.T, intent *domain.PendingIntent, mutate func(*domain.ExecutionTicket)) {
	t.Helper()
	var ticket domain.ExecutionTicket
	if err := json.Unmarshal([]byte(intent.Ticket), &ticket); err != nil {
		t.Fatalf("decode ticket: %v", err)
	}
	mutate(&ticket)
	ticketJSON, err := domain.StableJSON(ticket)
	if err != nil {
		t.Fatalf("ticket json: %v", err)
	}
	intent.Ticket = ticketJSON
}

func postJSON(router stdhttp.Handler, path string, body any) *httptest.ResponseRecorder {
	encoded, _ := json.Marshal(body)
	req := httptest.NewRequest(stdhttp.MethodPost, path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func get(router stdhttp.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(stdhttp.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func testWitnessPackage(t *testing.T, kind domain.IntentCircuitKind, commitmentHash, size, minOut string, expiry int64, dcaGroupLockID ...string) domain.EncryptedWitnessPackage {
	t.Helper()
	lockID := ""
	if len(dcaGroupLockID) > 0 {
		lockID = dcaGroupLockID[0]
	}
	pkg := domain.EncryptedWitnessPackage{
		Version:          1,
		CommitmentHash:   commitmentHash,
		Kind:             kind,
		CommitteeID:      "local-dev",
		EnclaveKeyID:     hash("aa"),
		EncryptionScheme: domain.WitnessEncryptionScheme,
		Ciphertext:       "0x1234",
		AAD: domain.PublicIntentMetadata{
			Version:        1,
			ChainID:        421614,
			Registry:       addr("99"),
			CommitmentHash: commitmentHash,
			Kind:           kind,
			DCAGroupLockID: lockID,
			TokenIn:        addr("11"),
			TokenOut:       addr("22"),
			Size:           size,
			MinOut:         minOut,
			Expiry:         expiry,
		},
	}
	packageHash, err := domain.WitnessPackageHash(pkg)
	if err != nil {
		t.Fatalf("package hash: %v", err)
	}
	pkg.PackageHash = packageHash
	return pkg
}

func testTicketReadyIntent(t *testing.T, intentKind domain.IntentKind, circuitKind domain.IntentCircuitKind, commitmentHash string, chainID int64, ttl time.Duration) *domain.PendingIntent {
	t.Helper()
	expiresAt := time.Now().Add(ttl)
	registry := addr("99")
	ticket := domain.ExecutionTicket{
		Version:         1,
		ChainID:         chainID,
		Registry:        registry,
		CommitmentHash:  commitmentHash,
		Kind:            circuitKind,
		Nullifier:       hash("77"),
		FillRef:         "0",
		Proof:           "0xabcd",
		TicketExpiresAt: expiresAt.Unix(),
		PackageHash:     hash("88"),
		ProverID:        hash("99"),
		ProverReceipt: domain.ProverReceipt{
			ProverID:        hash("99"),
			TicketExpiresAt: expiresAt.Unix(),
			Signature:       "0x99",
		},
	}
	if circuitKind == domain.CircuitKindDCA {
		ticket.FillRef = "1700000000"
	}
	ticketJSON, err := domain.StableJSON(ticket)
	if err != nil {
		t.Fatalf("ticket json: %v", err)
	}
	return &domain.PendingIntent{
		CommitmentHash:  commitmentHash,
		ChainID:         chainID,
		Registry:        registry,
		Kind:            intentKind,
		TokenIn:         addr("11"),
		TokenOut:        addr("22"),
		Size:            "100",
		MinOut:          "90",
		Expiry:          time.Now().Add(time.Hour).Unix(),
		WitnessPackage:  `{"ciphertext":"redacted"}`,
		Ticket:          ticketJSON,
		TicketExpiresAt: &expiresAt,
		Status:          domain.IntentTicketReady,
	}
}

func hash(byte string) string {
	return "0x" + strings.Repeat(byte, 32)
}

func addr(byte string) string {
	return "0x" + strings.Repeat(byte, 20)
}
