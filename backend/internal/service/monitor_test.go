package service

import (
	"context"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/zstrategy/backend/internal/domain"
)

type monitorIntentRepo struct {
	intents map[string]*domain.PendingIntent
}

func newMonitorIntentRepo(intents ...*domain.PendingIntent) *monitorIntentRepo {
	repo := &monitorIntentRepo{intents: make(map[string]*domain.PendingIntent)}
	for _, intent := range intents {
		cp := *intent
		repo.intents[intent.CommitmentHash] = &cp
	}
	return repo
}

func (r *monitorIntentRepo) Save(_ context.Context, intent *domain.PendingIntent) error {
	cp := *intent
	r.intents[intent.CommitmentHash] = &cp
	return nil
}

func (r *monitorIntentRepo) SaveBatch(_ context.Context, intents []*domain.PendingIntent) error {
	for _, intent := range intents {
		_ = r.Save(context.Background(), intent)
	}
	return nil
}

func (r *monitorIntentRepo) GetByHash(_ context.Context, hash string) (*domain.PendingIntent, error) {
	return r.intents[hash], nil
}

func (r *monitorIntentRepo) UpdateStatus(_ context.Context, hash string, status domain.IntentStatus) error {
	r.intents[hash].Status = status
	return nil
}

func (r *monitorIntentRepo) ClaimForEvaluation(_ context.Context, hash string) (bool, error) {
	intent := r.intents[hash]
	if intent.Status != domain.IntentPending {
		return false, nil
	}
	intent.Status = domain.IntentEvaluating
	return true, nil
}

func (r *monitorIntentRepo) StoreTicket(_ context.Context, hash, ticket string, expiresAt time.Time) (bool, error) {
	intent := r.intents[hash]
	if intent.Status != domain.IntentEvaluating {
		return false, nil
	}
	intent.Status = domain.IntentTicketReady
	intent.Ticket = ticket
	intent.TicketExpiresAt = &expiresAt
	intent.LeasedBy = ""
	intent.LeaseExpiresAt = nil
	return true, nil
}

func (r *monitorIntentRepo) ClaimTicketLease(_ context.Context, hash, leasedBy string, now, leaseExpiresAt time.Time) (bool, error) {
	intent := r.intents[hash]
	if intent.Status != domain.IntentTicketReady ||
		intent.TicketExpiresAt == nil ||
		!intent.TicketExpiresAt.After(now) {
		return false, nil
	}
	if intent.LeaseExpiresAt != nil && intent.LeaseExpiresAt.After(now) && !strings.EqualFold(intent.LeasedBy, leasedBy) {
		return false, nil
	}
	intent.LeasedBy = leasedBy
	intent.LeaseExpiresAt = &leaseExpiresAt
	return true, nil
}

func (r *monitorIntentRepo) MarkFailed(_ context.Context, hash, reason string) (bool, error) {
	intent := r.intents[hash]
	if intent.Status != domain.IntentEvaluating {
		return false, nil
	}
	intent.Status = domain.IntentFailed
	intent.LastError = reason
	return true, nil
}

func (r *monitorIntentRepo) ResetEvaluation(_ context.Context, hash string) (bool, error) {
	intent := r.intents[hash]
	if intent.Status != domain.IntentEvaluating {
		return false, nil
	}
	intent.Status = domain.IntentPending
	intent.Ticket = ""
	intent.TicketExpiresAt = nil
	intent.LeasedBy = ""
	intent.LeaseExpiresAt = nil
	return true, nil
}

func (r *monitorIntentRepo) ResetTicket(_ context.Context, hash, reason string) (bool, error) {
	intent := r.intents[hash]
	if intent.Status != domain.IntentTicketReady {
		return false, nil
	}
	intent.Status = domain.IntentPending
	intent.Ticket = ""
	intent.TicketExpiresAt = nil
	intent.LeasedBy = ""
	intent.LeaseExpiresAt = nil
	intent.LastError = reason
	return true, nil
}

func (r *monitorIntentRepo) ListPending(context.Context) ([]*domain.PendingIntent, error) {
	return nil, nil
}

func (r *monitorIntentRepo) ListTicketReady(context.Context) ([]*domain.PendingIntent, error) {
	return nil, nil
}

func (r *monitorIntentRepo) CountByStatus(context.Context, domain.IntentStatus) (int64, error) {
	return 0, nil
}

func (r *monitorIntentRepo) ResetStuckExecuting(context.Context, time.Duration) ([]*domain.PendingIntent, error) {
	var reset []*domain.PendingIntent
	for _, intent := range r.intents {
		if intent.Status != domain.IntentEvaluating {
			continue
		}
		intent.Status = domain.IntentPending
		intent.LeasedBy = ""
		intent.LeaseExpiresAt = nil
		cp := *intent
		reset = append(reset, &cp)
	}
	return reset, nil
}

func (r *monitorIntentRepo) ResetExpiredTickets(_ context.Context, now time.Time) ([]*domain.PendingIntent, error) {
	var reset []*domain.PendingIntent
	for _, intent := range r.intents {
		if intent.Status != domain.IntentTicketReady || intent.TicketExpiresAt == nil || intent.TicketExpiresAt.After(now) {
			continue
		}
		intent.Status = domain.IntentPending
		intent.Ticket = ""
		intent.TicketExpiresAt = nil
		intent.LeasedBy = ""
		intent.LeaseExpiresAt = nil
		cp := *intent
		reset = append(reset, &cp)
	}
	return reset, nil
}

type fakeEnclaveClient struct {
	imports        int
	evaluations    []domain.FillContext
	ready          bool
	evaluateError  error
	importError    error
	ticketOverride *domain.ExecutionTicket
	ticketKind     domain.IntentCircuitKind
	packageHashes  map[string]string
	onImport       func()
	onEvaluate     func()
	pruned         []string
}

func (e *fakeEnclaveClient) Metadata(context.Context) (*EnclaveMetadata, error) { return nil, nil }
func (e *fakeEnclaveClient) Attest(context.Context, AttestationRequest) (map[string]any, error) {
	return nil, nil
}
func (e *fakeEnclaveClient) ImportPackage(_ context.Context, pkg domain.EncryptedWitnessPackage) error {
	e.imports++
	if e.onImport != nil {
		e.onImport()
	}
	if e.packageHashes == nil {
		e.packageHashes = make(map[string]string)
	}
	e.packageHashes[pkg.CommitmentHash] = pkg.PackageHash
	return e.importError
}
func (e *fakeEnclaveClient) Evaluate(_ context.Context, hash string, fillCtx domain.FillContext) (*domain.ExecutionTicket, bool, error) {
	e.evaluations = append(e.evaluations, fillCtx)
	if e.onEvaluate != nil {
		e.onEvaluate()
	}
	if e.evaluateError != nil {
		return nil, false, e.evaluateError
	}
	if !e.ready {
		return nil, false, nil
	}
	if e.ticketOverride != nil {
		cp := *e.ticketOverride
		return &cp, true, nil
	}
	kind := e.ticketKind
	if kind == "" {
		kind = domain.CircuitKindOrderFill
	}
	fillRef := "0"
	if kind == domain.CircuitKindDCA {
		fillRef = strconv.FormatInt(fillCtx.BlockTimestamp, 10)
	}
	expiresAt := time.Now().Add(time.Minute).Unix()
	return &domain.ExecutionTicket{
		Version:         1,
		ChainID:         fillCtx.ChainID,
		Registry:        fillCtx.Registry,
		CommitmentHash:  hash,
		Kind:            kind,
		Nullifier:       hashOf("77"),
		FillRef:         fillRef,
		Proof:           "0xabcd",
		TicketExpiresAt: expiresAt,
		PackageHash:     e.packageHashes[hash],
		ProverID:        hashOf("99"),
		ProverReceipt: domain.ProverReceipt{
			ProverID:        hashOf("99"),
			TicketExpiresAt: expiresAt,
			Signature:       "0x99",
		},
	}, true, nil
}
func (e *fakeEnclaveClient) Prune(_ context.Context, hash string) error {
	e.pruned = append(e.pruned, hash)
	return nil
}

func TestSchedulerResetsNotReadyLimitWithoutPublishingTicket(t *testing.T) {
	intent := testPendingIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hashOf("01"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: false}
	monitor := testMonitor(repo, enclave, 101)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentPending {
		t.Fatalf("status = %s, want PENDING", got.Status)
	}
	if got.Ticket != "" {
		t.Fatalf("ticket = %q, want empty", got.Ticket)
	}
	if len(enclave.evaluations) != 1 || enclave.evaluations[0].OraclePrice != "101" {
		t.Fatalf("oracle context = %#v", enclave.evaluations)
	}
}

func TestSchedulerPublishesMarketTicketWithFreshOracleContext(t *testing.T) {
	intent := testPendingIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hashOf("02"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: true}
	monitor := testMonitor(repo, enclave, 123)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentTicketReady {
		t.Fatalf("status = %s, want TICKET_READY", got.Status)
	}
	if got.Ticket == "" || got.TicketExpiresAt == nil {
		t.Fatalf("ticket was not stored: %#v", got)
	}
	if enclave.evaluations[0].OraclePrice != "123" {
		t.Fatalf("oracle price = %s, want 123", enclave.evaluations[0].OraclePrice)
	}
}

func TestSchedulerDiscardsTicketIfCommitmentFinalizesDuringProof(t *testing.T) {
	intent := testPendingIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hashOf("03"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: true}
	monitor := testMonitor(repo, enclave, 100)
	checks := 0
	monitor.isOnChainPendingFn = func(context.Context, string) (bool, error) {
		checks++
		return checks == 1, nil
	}

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentDone {
		t.Fatalf("status = %s, want DONE", got.Status)
	}
	if got.Ticket != "" {
		t.Fatalf("ticket = %q, want empty", got.Ticket)
	}
	if len(enclave.pruned) != 1 {
		t.Fatalf("pruned = %d, want 1", len(enclave.pruned))
	}
}

func TestSchedulerClaimPreventsDuplicateEvaluation(t *testing.T) {
	intent := testPendingIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hashOf("04"))
	intent.Status = domain.IntentEvaluating
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: true}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	if enclave.imports != 0 || len(enclave.evaluations) != 0 {
		t.Fatalf("enclave called despite failed claim")
	}
}

func TestSchedulerResetsDcaNotReadyWithoutOracleRead(t *testing.T) {
	intent := testPendingIntent(t, domain.KindDCA, domain.CircuitKindDCA, hashOf("05"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: false}
	monitor := testMonitor(repo, enclave, 999)
	priceReads := 0
	monitor.fetchPairPriceFn = func(context.Context, string, string) (*big.Int, error) {
		priceReads++
		return big.NewInt(999), nil
	}

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	if priceReads != 0 {
		t.Fatalf("DCA should not read oracle, got %d reads", priceReads)
	}
	if repo.intents[intent.CommitmentHash].Status != domain.IntentPending {
		t.Fatalf("status = %s, want PENDING", repo.intents[intent.CommitmentHash].Status)
	}
}

func TestSchedulerPreventsConcurrentDcaProofJobsForSameGroup(t *testing.T) {
	lockID := hashOf("bb")
	first := testPendingIntent(t, domain.KindDCA, domain.CircuitKindDCA, hashOf("20"))
	second := testPendingIntent(t, domain.KindDCA, domain.CircuitKindDCA, hashOf("21"))
	first.DCAGroupLockID = lockID
	second.DCAGroupLockID = lockID
	repo := newMonitorIntentRepo(first, second)

	started := make(chan struct{})
	release := make(chan struct{})
	enclave := &fakeEnclaveClient{
		ready:      true,
		ticketKind: domain.CircuitKindDCA,
		onEvaluate: func() {
			select {
			case <-started:
			default:
				close(started)
			}
			<-release
		},
	}
	monitor := testMonitor(repo, enclave, 100)

	done := make(chan struct{})
	go func() {
		monitor.evaluateAndMaybeTicket(context.Background(), first)
		close(done)
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatalf("first DCA evaluation did not start")
	}

	monitor.evaluateAndMaybeTicket(context.Background(), second)
	if got := repo.intents[second.CommitmentHash].Status; got != domain.IntentPending {
		t.Fatalf("second status = %s, want PENDING while same group is proving", got)
	}
	if enclave.imports != 1 || len(enclave.evaluations) != 1 {
		t.Fatalf("second same-group intent reached enclave: imports=%d evaluations=%d", enclave.imports, len(enclave.evaluations))
	}

	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("first DCA evaluation did not finish")
	}
	if got := repo.intents[first.CommitmentHash].Status; got != domain.IntentTicketReady {
		t.Fatalf("first status = %s, want TICKET_READY", got)
	}
}

func TestSchedulerReleasesDcaProofLockAfterNotReady(t *testing.T) {
	lockID := hashOf("bb")
	first := testPendingIntent(t, domain.KindDCA, domain.CircuitKindDCA, hashOf("22"))
	second := testPendingIntent(t, domain.KindDCA, domain.CircuitKindDCA, hashOf("23"))
	first.DCAGroupLockID = lockID
	second.DCAGroupLockID = lockID
	repo := newMonitorIntentRepo(first, second)
	enclave := &fakeEnclaveClient{ready: false, ticketKind: domain.CircuitKindDCA}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), first)
	monitor.evaluateAndMaybeTicket(context.Background(), second)

	if got := repo.intents[first.CommitmentHash].Status; got != domain.IntentPending {
		t.Fatalf("first status = %s, want PENDING after NOT_READY", got)
	}
	if got := repo.intents[second.CommitmentHash].Status; got != domain.IntentPending {
		t.Fatalf("second status = %s, want PENDING after NOT_READY", got)
	}
	if enclave.imports != 2 || len(enclave.evaluations) != 2 {
		t.Fatalf("lock was not released after NOT_READY: imports=%d evaluations=%d", enclave.imports, len(enclave.evaluations))
	}
}

func TestSchedulerReleasesDcaProofLockAfterEvaluateError(t *testing.T) {
	lockID := hashOf("bb")
	first := testPendingIntent(t, domain.KindDCA, domain.CircuitKindDCA, hashOf("24"))
	second := testPendingIntent(t, domain.KindDCA, domain.CircuitKindDCA, hashOf("25"))
	first.DCAGroupLockID = lockID
	second.DCAGroupLockID = lockID
	repo := newMonitorIntentRepo(first, second)
	enclave := &fakeEnclaveClient{
		ready:         false,
		ticketKind:    domain.CircuitKindDCA,
		evaluateError: errors.New("temporary proof failure"),
	}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), first)
	monitor.evaluateAndMaybeTicket(context.Background(), second)

	if got := repo.intents[first.CommitmentHash].Status; got != domain.IntentPending {
		t.Fatalf("first status = %s, want PENDING after evaluate error", got)
	}
	if got := repo.intents[second.CommitmentHash].Status; got != domain.IntentPending {
		t.Fatalf("second status = %s, want PENDING after evaluate error", got)
	}
	if enclave.imports != 2 || len(enclave.evaluations) != 2 {
		t.Fatalf("lock was not released after evaluate error: imports=%d evaluations=%d", enclave.imports, len(enclave.evaluations))
	}
}

func TestSchedulerDoesNotReviveTerminalIntentAfterNotReadyRace(t *testing.T) {
	intent := testPendingIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hashOf("06"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{
		ready: false,
		onEvaluate: func() {
			repo.intents[intent.CommitmentHash].Status = domain.IntentDone
		},
	}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	if got := repo.intents[intent.CommitmentHash].Status; got != domain.IntentDone {
		t.Fatalf("status = %s, want DONE", got)
	}
}

func TestSchedulerDoesNotPublishTicketAfterDbTerminalRace(t *testing.T) {
	intent := testPendingIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hashOf("07"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{
		ready: true,
		onEvaluate: func() {
			repo.intents[intent.CommitmentHash].Status = domain.IntentDone
		},
	}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentDone {
		t.Fatalf("status = %s, want DONE", got.Status)
	}
	if got.Ticket != "" || got.TicketExpiresAt != nil {
		t.Fatalf("ticket stored after terminal race: %#v", got)
	}
}

func TestSchedulerDoesNotOverwriteTerminalIntentWithFailedImport(t *testing.T) {
	intent := testPendingIntent(t, domain.KindDCA, domain.CircuitKindDCA, hashOf("08"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{
		importError: errors.New("bad package"),
		onImport: func() {
			repo.intents[intent.CommitmentHash].Status = domain.IntentDone
		},
	}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentDone {
		t.Fatalf("status = %s, want DONE", got.Status)
	}
	if got.LastError != "" {
		t.Fatalf("last error = %q, want empty", got.LastError)
	}
}

func TestSchedulerRetriesTransientImportFailure(t *testing.T) {
	intent := testPendingIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hashOf("09"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{importError: errors.New("temporary enclave outage")}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentPending {
		t.Fatalf("status = %s, want PENDING", got.Status)
	}
	if got.LastError != "" {
		t.Fatalf("last error = %q, want empty for retryable failure", got.LastError)
	}
	if len(enclave.evaluations) != 0 {
		t.Fatalf("evaluate calls = %d, want 0 after import failure", len(enclave.evaluations))
	}
}

func TestSchedulerMarksPermanentImportFailure(t *testing.T) {
	intent := testPendingIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hashOf("0a"))
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{
		importError: &EnclaveHTTPError{
			Method:     "POST",
			Path:       "/packages",
			StatusCode: http.StatusBadRequest,
			Message:    "invalid witness package",
		},
	}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentFailed {
		t.Fatalf("status = %s, want FAILED", got.Status)
	}
	if !strings.Contains(got.LastError, "invalid witness package") {
		t.Fatalf("last error = %q, want permanent import reason", got.LastError)
	}
	if len(enclave.evaluations) != 0 {
		t.Fatalf("evaluate calls = %d, want 0 after permanent import failure", len(enclave.evaluations))
	}
}

func TestSchedulerRejectsMismatchedTicketWithoutPublishing(t *testing.T) {
	intent := testPendingIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hashOf("0b"))
	ticket := testExecutionTicket(t, intent)
	ticket.CommitmentHash = hashOf("ff")
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: true, ticketOverride: ticket}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentFailed {
		t.Fatalf("status = %s, want FAILED", got.Status)
	}
	if got.Ticket != "" || got.TicketExpiresAt != nil {
		t.Fatalf("mismatched ticket was stored: %#v", got)
	}
	if !strings.Contains(got.LastError, "ticket public metadata") {
		t.Fatalf("last error = %q, want ticket metadata error", got.LastError)
	}
}

func TestSchedulerRejectsTicketMissingProverReceiptWithoutPublishing(t *testing.T) {
	intent := testPendingIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hashOf("0e"))
	ticket := testExecutionTicket(t, intent)
	ticket.ProverReceipt = domain.ProverReceipt{}
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: true, ticketOverride: ticket}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentFailed {
		t.Fatalf("status = %s, want FAILED", got.Status)
	}
	if got.Ticket != "" || got.TicketExpiresAt != nil {
		t.Fatalf("ticket missing prover receipt was stored: %#v", got)
	}
	if !strings.Contains(got.LastError, "ticket missing proverReceipt") {
		t.Fatalf("last error = %q, want prover receipt error", got.LastError)
	}
}

func TestRegistryReadABIPacksPhaseEExecuteCommitment(t *testing.T) {
	regABI, err := abi.JSON(strings.NewReader(registryReadABI))
	if err != nil {
		t.Fatalf("parse registry ABI: %v", err)
	}
	data, err := regABI.Pack(
		"executeCommitment",
		common.HexToHash(hashOf("01")),
		common.HexToHash(hashOf("02")),
		common.FromHex("0xabcd"),
		uint64(0),
		proverReceiptCall{
			ProverId:        common.HexToHash(hashOf("99")),
			TicketExpiresAt: 123,
			Signature:       common.FromHex("0x99"),
		},
	)
	if err != nil {
		t.Fatalf("pack executeCommitment: %v", err)
	}
	method, err := regABI.MethodById(data[:4])
	if err != nil {
		t.Fatalf("method id: %v", err)
	}
	if method.Name != "executeCommitment" || len(method.Inputs) != 5 {
		t.Fatalf("method = %s inputs=%d, want executeCommitment with 5 inputs", method.Name, len(method.Inputs))
	}
}

func TestSchedulerRetriesExpiredTicketWithoutPublishing(t *testing.T) {
	intent := testPendingIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hashOf("0c"))
	ticket := testExecutionTicket(t, intent)
	ticket.TicketExpiresAt = time.Now().Add(-time.Minute).Unix()
	ticket.ProverReceipt.TicketExpiresAt = ticket.TicketExpiresAt
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: true, ticketOverride: ticket}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(context.Background(), intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentPending {
		t.Fatalf("status = %s, want PENDING", got.Status)
	}
	if got.Ticket != "" || got.TicketExpiresAt != nil {
		t.Fatalf("expired ticket was stored: %#v", got)
	}
	if got.LastError != "" {
		t.Fatalf("last error = %q, want empty for retryable expired ticket", got.LastError)
	}
}

func TestSchedulerDoesNotStoreTicketAfterContextCancelledDuringEvaluate(t *testing.T) {
	intent := testPendingIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hashOf("0d"))
	repo := newMonitorIntentRepo(intent)
	ctx, cancel := context.WithCancel(context.Background())
	enclave := &fakeEnclaveClient{
		ready:      true,
		onEvaluate: cancel,
	}
	monitor := testMonitor(repo, enclave, 100)

	monitor.evaluateAndMaybeTicket(ctx, intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentEvaluating {
		t.Fatalf("status = %s, want EVALUATING for sweeper recovery", got.Status)
	}
	if got.Ticket != "" || got.TicketExpiresAt != nil {
		t.Fatalf("ticket stored after context cancellation: %#v", got)
	}
}

func TestSchedulerDoesNotStoreTicketAfterContextCancelledDuringPostProofCheck(t *testing.T) {
	intent := testPendingIntent(t, domain.KindMarket, domain.CircuitKindOrderFill, hashOf("0e"))
	repo := newMonitorIntentRepo(intent)
	ctx, cancel := context.WithCancel(context.Background())
	enclave := &fakeEnclaveClient{ready: true}
	monitor := testMonitor(repo, enclave, 100)
	checks := 0
	monitor.isOnChainPendingFn = func(context.Context, string) (bool, error) {
		checks++
		if checks == 2 {
			cancel()
		}
		return true, nil
	}

	monitor.evaluateAndMaybeTicket(ctx, intent)

	got := repo.intents[intent.CommitmentHash]
	if got.Status != domain.IntentEvaluating {
		t.Fatalf("status = %s, want EVALUATING for sweeper recovery", got.Status)
	}
	if got.Ticket != "" || got.TicketExpiresAt != nil {
		t.Fatalf("ticket stored after post-proof cancellation: %#v", got)
	}
}

func TestSweepRetryableCancelsExistingMonitorBeforeRestart(t *testing.T) {
	intent := testPendingIntent(t, domain.KindLimit, domain.CircuitKindOrderFill, hashOf("0f"))
	intent.Status = domain.IntentEvaluating
	repo := newMonitorIntentRepo(intent)
	enclave := &fakeEnclaveClient{ready: false}
	monitor := testMonitor(repo, enclave, 100)
	cancelled := false
	monitor.stopChans[intent.CommitmentHash] = trackedMonitor{
		cancel: func() { cancelled = true },
		kind:   intent.Kind,
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	monitor.sweepRetryable(ctx)
	monitor.StopMonitoring(intent.CommitmentHash)

	if !cancelled {
		t.Fatalf("existing monitor was not cancelled before retry restart")
	}
	if got := repo.intents[intent.CommitmentHash].Status; got != domain.IntentPending {
		t.Fatalf("status = %s, want PENDING after stuck sweep", got)
	}
}

func TestDerivePairPriceMatchesRegistryFormula(t *testing.T) {
	price, err := derivePairPrice(
		big.NewInt(1_00000000),
		8,
		big.NewInt(2900_00000000),
		8,
	)
	if err != nil {
		t.Fatalf("derivePairPrice: %v", err)
	}
	if price.Cmp(big.NewInt(34482)) != 0 {
		t.Fatalf("price = %s, want 34482", price)
	}
}

func TestDerivePairPriceRejectsUnsupportedOracleDecimals(t *testing.T) {
	_, err := derivePairPrice(big.NewInt(1), 19, big.NewInt(1), 8)
	if err == nil || !strings.Contains(err.Error(), "decimals") {
		t.Fatalf("err = %v, want decimals error", err)
	}
}

func TestDerivePairPriceRejectsUint64Overflow(t *testing.T) {
	overflow := new(big.Int).Add(new(big.Int).SetUint64(^uint64(0)), big.NewInt(1))
	_, err := derivePairPrice(overflow, 8, big.NewInt(1_00000000), 8)
	if err == nil || !strings.Contains(err.Error(), "overflows uint64") {
		t.Fatalf("err = %v, want uint64 overflow error", err)
	}
}

func testMonitor(repo *monitorIntentRepo, enclave *fakeEnclaveClient, oraclePrice int64) *MonitorService {
	monitor := NewMonitorService(repo, nil, "", enclave)
	monitor.isOnChainPendingFn = func(context.Context, string) (bool, error) { return true, nil }
	monitor.latestBlockContextFn = func(_ context.Context, fallback int64) (string, int64, error) {
		return "123", fallback, nil
	}
	monitor.fetchPairPriceFn = func(context.Context, string, string) (*big.Int, error) {
		return big.NewInt(oraclePrice), nil
	}
	return monitor
}

func testPendingIntent(t *testing.T, kind domain.IntentKind, circuitKind domain.IntentCircuitKind, commitmentHash string) *domain.PendingIntent {
	t.Helper()
	dcaGroupLockID := ""
	if kind == domain.KindDCA {
		dcaGroupLockID = hashOf("bb")
	}
	pkg := domain.EncryptedWitnessPackage{
		Version:          1,
		CommitmentHash:   commitmentHash,
		Kind:             circuitKind,
		CommitteeID:      "local-dev",
		EnclaveKeyID:     hashOf("aa"),
		EncryptionScheme: domain.WitnessEncryptionScheme,
		Ciphertext:       "0x1234",
		AAD: domain.PublicIntentMetadata{
			Version:        1,
			ChainID:        421614,
			Registry:       addressOf("99"),
			CommitmentHash: commitmentHash,
			Kind:           circuitKind,
			DCAGroupLockID: dcaGroupLockID,
			TokenIn:        addressOf("11"),
			TokenOut:       addressOf("22"),
			Size:           "100",
			MinOut:         "90",
			Expiry:         time.Now().Add(time.Hour).Unix(),
		},
	}
	packageHash, err := domain.WitnessPackageHash(pkg)
	if err != nil {
		t.Fatalf("package hash: %v", err)
	}
	pkg.PackageHash = packageHash
	pkgJSON, err := domain.StableJSON(pkg)
	if err != nil {
		t.Fatalf("package json: %v", err)
	}
	return &domain.PendingIntent{
		CommitmentHash: commitmentHash,
		ChainID:        pkg.AAD.ChainID,
		Registry:       pkg.AAD.Registry,
		Kind:           kind,
		DCAGroupLockID: dcaGroupLockID,
		TokenIn:        pkg.AAD.TokenIn,
		TokenOut:       pkg.AAD.TokenOut,
		Size:           pkg.AAD.Size,
		MinOut:         pkg.AAD.MinOut,
		Expiry:         pkg.AAD.Expiry,
		WitnessPackage: pkgJSON,
		Status:         domain.IntentPending,
	}
}

func testExecutionTicket(t *testing.T, intent *domain.PendingIntent) *domain.ExecutionTicket {
	t.Helper()
	pkg, err := decodeStoredPackage(intent)
	if err != nil {
		t.Fatalf("decode package: %v", err)
	}
	expiresAt := time.Now().Add(time.Minute).Unix()
	return &domain.ExecutionTicket{
		Version:         1,
		ChainID:         intent.ChainID,
		Registry:        intent.Registry,
		CommitmentHash:  intent.CommitmentHash,
		Kind:            pkg.Kind,
		Nullifier:       hashOf("77"),
		FillRef:         "0",
		Proof:           "0xabcd",
		TicketExpiresAt: expiresAt,
		PackageHash:     pkg.PackageHash,
		ProverID:        hashOf("99"),
		ProverReceipt: domain.ProverReceipt{
			ProverID:        hashOf("99"),
			TicketExpiresAt: expiresAt,
			Signature:       "0x99",
		},
	}
}

func hashOf(byte string) string {
	return "0x" + strings.Repeat(byte, 32)
}

func addressOf(byte string) string {
	return "0x" + strings.Repeat(byte, 20)
}
