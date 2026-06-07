package http

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/gin-gonic/gin"
	"github.com/zstrategy/backend/config"
	"github.com/zstrategy/backend/internal/domain"
	"github.com/zstrategy/backend/internal/service"
)

const executorTicketLeaseDuration = 60 * time.Second

type Handler struct {
	stats           *service.StatsService
	indexer         *service.IndexerService
	intentRepo      domain.IntentRepository
	monitor         *service.MonitorService
	enclave         service.EnclaveClient
	registryAddress string
	validateClaimFn func(context.Context, string, domain.ExecutionTicket) (service.TicketClaimCheck, error)
}

func NewHandler(
	stats *service.StatsService,
	indexer *service.IndexerService,
	intentRepo domain.IntentRepository,
	monitor *service.MonitorService,
	enclave service.EnclaveClient,
	registryAddress string,
) *Handler {
	var validateClaimFn func(context.Context, string, domain.ExecutionTicket) (service.TicketClaimCheck, error)
	if monitor != nil {
		validateClaimFn = monitor.ValidateExecutionTicketClaim
	}
	return &Handler{
		stats:           stats,
		indexer:         indexer,
		intentRepo:      intentRepo,
		monitor:         monitor,
		enclave:         enclave,
		registryAddress: registryAddress,
		validateClaimFn: validateClaimFn,
	}
}

func (h *Handler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (h *Handler) GetStats(c *gin.Context) {
	chainID := parseChainID(c)
	stats, err := h.stats.GetStatistics(c.Request.Context(), chainID)
	if err != nil {
		errResponse(c, err)
		return
	}
	ok(c, stats)
}

func (h *Handler) ListExecutions(c *gin.Context) {
	chainID := parseChainID(c)
	filters := domain.ExecutionFilters{
		Query: strings.TrimSpace(c.DefaultQuery("q", "")),
	}
	if status := domain.ExecutionStatus(c.DefaultQuery("status", "")); status == domain.StatusRegistered ||
		status == domain.StatusExecuted || status == domain.StatusCancelled || status == domain.StatusExpired {
		filters.Status = status
	}
	if kind := parseIntentKind(c.DefaultQuery("kind", "")); kind != "" {
		filters.Kind = kind
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))

	records, err := h.stats.GetExecutions(c.Request.Context(), chainID, filters, limit, offset)
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"data":   records,
		"limit":  limit,
		"offset": offset,
	})
}

func (h *Handler) GetEnclaveAttestation(c *gin.Context) {
	if h.enclave == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "enclave client not configured"})
		return
	}

	var body service.AttestationRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}
	if body.Nonce == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing nonce"})
		return
	}

	ctx := c.Request.Context()
	metadata, err := h.enclave.Metadata(ctx)
	if err != nil {
		errResponse(c, err)
		return
	}
	report, err := h.enclave.Attest(ctx, body)
	if err != nil {
		errResponse(c, err)
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"report": report,
		"expected": gin.H{
			"rootPublicKeyPem": metadata.RootPublicKeyPem,
			"imageDigest":      metadata.ImageDigest,
			"pcrs":             metadata.PCRs,
		},
	})
}

type executionTicketResponse struct {
	CommitmentHash  string                   `json:"commitmentHash"`
	ChainID         int64                    `json:"chainId"`
	Registry        string                   `json:"registry"`
	IntentKind      domain.IntentKind        `json:"intentKind"`
	CircuitKind     domain.IntentCircuitKind `json:"circuitKind"`
	TicketExpiresAt int64                    `json:"ticketExpiresAt"`
	LeasedBy        string                   `json:"leasedBy,omitempty"`
	LeaseExpiresAt  int64                    `json:"leaseExpiresAt,omitempty"`
	Ticket          domain.ExecutionTicket   `json:"ticket"`
}

func (h *Handler) ListExecutionTickets(c *gin.Context) {
	tickets, err := h.readyExecutionTickets(c, "", "")
	if err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"data":  tickets,
		"limit": ticketLimit(c),
	})
}

type claimExecutionTicketBody struct {
	Executor       string `json:"executor"`
	CommitmentHash string `json:"commitmentHash"`
}

func (h *Handler) ClaimExecutionTicket(c *gin.Context) {
	leaseOwner, targetCommitmentHash, valid := claimRequest(c)
	if !valid {
		return
	}
	if h.validateClaimFn == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "claim simulation unavailable"})
		return
	}

	tickets, err := h.readyExecutionTickets(c, leaseOwner, targetCommitmentHash)
	if err != nil {
		errResponse(c, err)
		return
	}
	if len(tickets) == 0 {
		if targetCommitmentHash != "" {
			c.JSON(http.StatusNotFound, gin.H{"error": "execution ticket not ready for commitment"})
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"error": "no execution tickets ready"})
		return
	}

	var lastUnclaimableReason string
	for i := range tickets {
		now := time.Now()
		leaseExpiresAt := now.Add(executorTicketLeaseDuration)
		ticketExpiresAt := time.Unix(tickets[i].TicketExpiresAt, 0)
		if ticketExpiresAt.Before(leaseExpiresAt) {
			leaseExpiresAt = ticketExpiresAt
		}
		leased, err := h.intentRepo.ClaimTicketLease(c.Request.Context(), tickets[i].CommitmentHash, leaseOwner, now, leaseExpiresAt)
		if err != nil {
			errResponse(c, err)
			return
		}
		if !leased {
			continue
		}

		check, err := h.validateClaimFn(c.Request.Context(), leaseOwner, tickets[i].Ticket)
		if err != nil {
			errResponse(c, err)
			return
		}
		if check.Executable {
			tickets[i].LeasedBy = leaseOwner
			tickets[i].LeaseExpiresAt = leaseExpiresAt.Unix()
			ok(c, tickets[i])
			return
		}

		lastUnclaimableReason = strings.TrimSpace(check.Reason)
		h.handleUnclaimableTicket(c.Request.Context(), tickets[i], check)
	}
	if lastUnclaimableReason != "" {
		c.JSON(http.StatusConflict, gin.H{
			"error":  "execution ticket is not currently claimable",
			"reason": lastUnclaimableReason,
		})
		return
	}
	c.JSON(http.StatusNotFound, gin.H{"error": "no execution tickets ready"})
}

func (h *Handler) handleUnclaimableTicket(ctx context.Context, ticket executionTicketResponse, check service.TicketClaimCheck) {
	if check.CommitmentPending {
		reset, err := h.intentRepo.ResetTicket(ctx, ticket.CommitmentHash, "claim simulation failed: "+check.Reason)
		if err != nil {
			log.Printf("[Handler] reset stale ticket %s...: %v", shortHash(ticket.CommitmentHash), err)
			return
		}
		if reset && h.monitor != nil {
			intent, err := h.intentRepo.GetByHash(ctx, ticket.CommitmentHash)
			if err != nil {
				log.Printf("[Handler] reload reset ticket %s...: %v", shortHash(ticket.CommitmentHash), err)
				return
			}
			if intent != nil {
				h.monitor.StartMonitoring(ctx, intent)
			}
		}
		return
	}

	if h.monitor != nil {
		h.monitor.UpdateStatus(ctx, ticket.CommitmentHash, domain.IntentDone)
		return
	}
	if err := h.intentRepo.UpdateStatus(ctx, ticket.CommitmentHash, domain.IntentDone); err != nil {
		log.Printf("[Handler] mark finalized ticket %s... DONE: %v", shortHash(ticket.CommitmentHash), err)
	}
}

func (h *Handler) readyExecutionTickets(c *gin.Context, leaseOwner, targetCommitmentHash string) ([]executionTicketResponse, error) {
	chainID := parseChainID(c)
	limit := ticketLimit(c)
	targetCommitmentHash = strings.TrimSpace(targetCommitmentHash)
	intents, err := h.intentRepo.ListTicketReady(c.Request.Context())
	if err != nil {
		return nil, err
	}

	now := time.Now()
	capacity := min(limit, len(intents))
	if targetCommitmentHash != "" {
		capacity = 1
	}
	out := make([]executionTicketResponse, 0, capacity)
	for _, intent := range intents {
		if intent.ChainID != chainID {
			continue
		}
		if targetCommitmentHash != "" && !strings.EqualFold(intent.CommitmentHash, targetCommitmentHash) {
			continue
		}
		if !ticketLeaseAvailable(intent, now, leaseOwner) {
			continue
		}
		ticket, ok := executionTicketFromPendingIntent(intent, now)
		if !ok {
			continue
		}
		out = append(out, ticket)
		if targetCommitmentHash != "" || len(out) >= limit {
			break
		}
	}
	return out, nil
}

func claimRequest(c *gin.Context) (string, string, bool) {
	var body claimExecutionTicketBody
	if c.Request.Body != nil {
		if err := c.ShouldBindJSON(&body); err != nil && err != io.EOF {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
			return "", "", false
		}
	}
	executor := strings.TrimSpace(body.Executor)
	if executor == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "executor is required for claim simulation"})
		return "", "", false
	}
	if executor != "" && !isHexAddress(executor) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "executor must be an EVM address"})
		return "", "", false
	}
	commitmentHash := strings.TrimSpace(body.CommitmentHash)
	if commitmentHash != "" && !isHexBytes32(commitmentHash) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "commitmentHash must be bytes32 hex"})
		return "", "", false
	}
	return strings.ToLower(executor), strings.ToLower(commitmentHash), true
}

func isHexAddress(value string) bool {
	if len(value) != 42 || !strings.HasPrefix(value, "0x") {
		return false
	}
	for _, r := range value[2:] {
		if !unicode.IsDigit(r) && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}

func isHexBytes32(value string) bool {
	return len(value) == 66 && isHexData(value)
}

func isHexData(value string) bool {
	if len(value) < 2 || !strings.HasPrefix(value, "0x") || len(value)%2 != 0 {
		return false
	}
	for _, r := range value[2:] {
		if !unicode.IsDigit(r) && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
			return false
		}
	}
	return true
}

func ticketLeaseAvailable(intent *domain.PendingIntent, now time.Time, leaseOwner string) bool {
	if intent.LeaseExpiresAt == nil || !intent.LeaseExpiresAt.After(now) {
		return true
	}
	return leaseOwner != "" && strings.EqualFold(intent.LeasedBy, leaseOwner)
}

func executionTicketFromPendingIntent(intent *domain.PendingIntent, now time.Time) (executionTicketResponse, bool) {
	if intent == nil ||
		intent.Status != domain.IntentTicketReady ||
		intent.Ticket == "null" ||
		intent.TicketExpiresAt == nil ||
		!intent.TicketExpiresAt.After(now) {
		return executionTicketResponse{}, false
	}

	var ticket domain.ExecutionTicket
	if err := json.Unmarshal([]byte(intent.Ticket), &ticket); err != nil {
		return executionTicketResponse{}, false
	}
	if ticket.TicketExpiresAt <= now.Unix() ||
		ticket.ChainID != intent.ChainID ||
		!strings.EqualFold(ticket.Registry, intent.Registry) ||
		!strings.EqualFold(ticket.CommitmentHash, intent.CommitmentHash) ||
		!ticketKindMatchesIntent(intent.Kind, ticket.Kind) ||
		!ticketFillRefValid(ticket.Kind, ticket.FillRef) ||
		ticket.PackageHash == "" ||
		ticket.Proof == "" ||
		ticket.Nullifier == "" ||
		!isHexBytes32(ticket.ProverID) ||
		!strings.EqualFold(ticket.ProverReceipt.ProverID, ticket.ProverID) ||
		ticket.ProverReceipt.TicketExpiresAt != ticket.TicketExpiresAt ||
		!isHexData(ticket.ProverReceipt.Signature) {
		return executionTicketResponse{}, false
	}

	resp := executionTicketResponse{
		CommitmentHash:  intent.CommitmentHash,
		ChainID:         intent.ChainID,
		Registry:        intent.Registry,
		IntentKind:      intent.Kind,
		CircuitKind:     ticket.Kind,
		TicketExpiresAt: ticket.TicketExpiresAt,
		Ticket:          ticket,
	}
	if intent.LeaseExpiresAt != nil && intent.LeaseExpiresAt.After(now) {
		resp.LeasedBy = intent.LeasedBy
		resp.LeaseExpiresAt = intent.LeaseExpiresAt.Unix()
	}
	return resp, true
}

func ticketKindMatchesIntent(intentKind domain.IntentKind, ticketKind domain.IntentCircuitKind) bool {
	if intentKind == domain.KindDCA {
		return ticketKind == domain.CircuitKindDCA
	}
	return ticketKind == domain.CircuitKindOrderFill
}

func ticketFillRefValid(ticketKind domain.IntentCircuitKind, fillRef string) bool {
	if ticketKind == domain.CircuitKindOrderFill {
		return fillRef == "0"
	}
	if ticketKind != domain.CircuitKindDCA {
		return false
	}
	_, err := strconv.ParseUint(fillRef, 10, 64)
	return err == nil
}

func ticketLimit(c *gin.Context) int {
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "20"))
	if err != nil || limit <= 0 {
		return 20
	}
	if limit > 100 {
		return 100
	}
	return limit
}

type registerOrderIntentBody struct {
	CommitmentHash string                         `json:"commitmentHash"`
	Kind           string                         `json:"kind"`
	ChainID        int64                          `json:"chainId"`
	TokenIn        string                         `json:"tokenIn"`
	TokenOut       string                         `json:"tokenOut"`
	Size           string                         `json:"size"`
	MinOut         string                         `json:"minOut"`
	Expiry         int64                          `json:"expiry"`
	WitnessPackage domain.EncryptedWitnessPackage `json:"witnessPackage"`
}

func (h *Handler) RegisterOrderIntent(c *gin.Context) {
	var body registerOrderIntentBody
	if !decodeJSONRejecting(c, &body, []string{
		"limitPrice", "direction", "nonce", "nullifier", "scheduledLo", "scheduledHi", "encryptedShares",
	}) {
		return
	}

	if body.CommitmentHash == "" || body.TokenIn == "" || body.TokenOut == "" ||
		body.Size == "" || body.MinOut == "" || body.WitnessPackage.PackageHash == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing required fields"})
		return
	}

	kind := parseOrderIntentKind(body.Kind)
	if kind == "" {
		if strings.TrimSpace(body.Kind) != "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "order intent kind must be LIMIT or MARKET"})
			return
		}
		kind = domain.KindLimit
	}

	witnessJSON, err := validateWitnessPackageForPublicMetadata(body.WitnessPackage, expectedPackageMetadata{
		chainID:        body.ChainID,
		registry:       body.WitnessPackage.AAD.Registry,
		commitmentHash: body.CommitmentHash,
		circuitKind:    domain.CircuitKindOrderFill,
		tokenIn:        body.TokenIn,
		tokenOut:       body.TokenOut,
		size:           body.Size,
		minOut:         body.MinOut,
		expiry:         body.Expiry,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if h.registryAddress != "" && !strings.EqualFold(body.WitnessPackage.AAD.Registry, h.registryAddress) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "witness package registry does not match backend registry"})
		return
	}

	s := &domain.PendingIntent{
		CommitmentHash: body.CommitmentHash,
		ChainID:        body.ChainID,
		Registry:       body.WitnessPackage.AAD.Registry,
		Kind:           kind,
		TokenIn:        body.TokenIn,
		TokenOut:       body.TokenOut,
		Size:           body.Size,
		MinOut:         body.MinOut,
		Expiry:         body.Expiry,
		WitnessPackage: witnessJSON,
		Status:         domain.IntentPending,
	}

	if err := h.intentRepo.Save(c.Request.Context(), s); err != nil {
		errResponse(c, err)
		return
	}
	if kind == domain.KindMarket && h.indexer != nil {
		if err := h.indexer.UpdateExecutionIntentKind(c.Request.Context(), body.CommitmentHash, domain.KindMarket); err != nil {
			log.Printf("[Handler] update execution kind for MARKET %s: %v", body.CommitmentHash, err)
		}
	}
	if h.monitor != nil {
		h.monitor.StartMonitoring(c.Request.Context(), s)
	}

	c.JSON(http.StatusCreated, gin.H{"status": "accepted", "commitmentHash": body.CommitmentHash})
}

type registerDcaIntentBody struct {
	ChainID        int64           `json:"chainId"`
	DCAGroupLockID string          `json:"dcaGroupLockId"`
	TokenIn        string          `json:"tokenIn"`
	TokenOut       string          `json:"tokenOut"`
	Rounds         []dcaRoundInput `json:"rounds"`
}

type dcaRoundInput struct {
	CommitmentHash string                         `json:"commitmentHash"`
	Size           string                         `json:"size"`
	MinOut         string                         `json:"minOut"`
	Expiry         int64                          `json:"expiry"`
	RoundIndex     int                            `json:"roundIndex"`
	WitnessPackage domain.EncryptedWitnessPackage `json:"witnessPackage"`
}

func (h *Handler) RegisterDcaIntent(c *gin.Context) {
	var body registerDcaIntentBody
	if !decodeDcaJSONRejecting(c, &body) {
		return
	}

	if body.TokenIn == "" || body.TokenOut == "" || len(body.Rounds) == 0 || !isHexBytes32(body.DCAGroupLockID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing required fields"})
		return
	}
	dcaGroupLockID := strings.ToLower(body.DCAGroupLockID)

	intents := make([]*domain.PendingIntent, 0, len(body.Rounds))
	for _, round := range body.Rounds {
		if round.CommitmentHash == "" || round.Size == "" || round.MinOut == "" || round.WitnessPackage.PackageHash == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "round missing required fields"})
			return
		}
		witnessJSON, err := validateWitnessPackageForPublicMetadata(round.WitnessPackage, expectedPackageMetadata{
			chainID:        body.ChainID,
			registry:       round.WitnessPackage.AAD.Registry,
			commitmentHash: round.CommitmentHash,
			circuitKind:    domain.CircuitKindDCA,
			dcaGroupLockID: dcaGroupLockID,
			tokenIn:        body.TokenIn,
			tokenOut:       body.TokenOut,
			size:           round.Size,
			minOut:         round.MinOut,
			expiry:         round.Expiry,
		})
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("round %d: %v", round.RoundIndex, err)})
			return
		}
		if h.registryAddress != "" && !strings.EqualFold(round.WitnessPackage.AAD.Registry, h.registryAddress) {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("round %d: witness package registry does not match backend registry", round.RoundIndex)})
			return
		}
		intents = append(intents, &domain.PendingIntent{
			CommitmentHash: round.CommitmentHash,
			ChainID:        body.ChainID,
			Registry:       round.WitnessPackage.AAD.Registry,
			Kind:           domain.KindDCA,
			DCAGroupLockID: dcaGroupLockID,
			TokenIn:        body.TokenIn,
			TokenOut:       body.TokenOut,
			Size:           round.Size,
			MinOut:         round.MinOut,
			Expiry:         round.Expiry,
			WitnessPackage: witnessJSON,
			Status:         domain.IntentPending,
		})
	}

	if err := h.intentRepo.SaveBatch(c.Request.Context(), intents); err != nil {
		errResponse(c, err)
		return
	}
	if h.monitor != nil {
		for _, intent := range intents {
			h.monitor.StartMonitoring(c.Request.Context(), intent)
		}
	}

	c.JSON(http.StatusCreated, gin.H{"status": "accepted", "saved": len(intents)})
}

type expectedPackageMetadata struct {
	chainID        int64
	registry       string
	commitmentHash string
	circuitKind    domain.IntentCircuitKind
	dcaGroupLockID string
	tokenIn        string
	tokenOut       string
	size           string
	minOut         string
	expiry         int64
}

func validateWitnessPackageForPublicMetadata(pkg domain.EncryptedWitnessPackage, expected expectedPackageMetadata) (string, error) {
	if err := domain.ValidateEncryptedWitnessPackage(pkg); err != nil {
		return "", err
	}
	if expected.registry == "" {
		return "", fmt.Errorf("witness package registry is required")
	}
	if pkg.AAD.ChainID != expected.chainID ||
		!strings.EqualFold(pkg.AAD.Registry, expected.registry) ||
		!strings.EqualFold(pkg.AAD.CommitmentHash, expected.commitmentHash) ||
		pkg.AAD.Kind != expected.circuitKind ||
		!strings.EqualFold(pkg.AAD.DCAGroupLockID, expected.dcaGroupLockID) ||
		!strings.EqualFold(pkg.AAD.TokenIn, expected.tokenIn) ||
		!strings.EqualFold(pkg.AAD.TokenOut, expected.tokenOut) ||
		pkg.AAD.Size != expected.size ||
		pkg.AAD.MinOut != expected.minOut ||
		pkg.AAD.Expiry != expected.expiry {
		return "", fmt.Errorf("witness package AAD does not match public intent metadata")
	}
	return domain.StableJSON(pkg)
}

func decodeJSONRejecting(c *gin.Context, dest any, forbidden []string) bool {
	data, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("read body: %v", err)})
		return false
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return false
	}
	for _, field := range forbidden {
		if _, ok := raw[field]; ok {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("plaintext witness field %q is not accepted on v2 intent routes", field)})
			return false
		}
	}
	if err := json.Unmarshal(data, dest); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return false
	}
	return true
}

func decodeDcaJSONRejecting(c *gin.Context, dest *registerDcaIntentBody) bool {
	data, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("read body: %v", err)})
		return false
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return false
	}
	if _, ok := raw["encryptedShares"]; ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "plaintext witness field \"encryptedShares\" is not accepted on v2 intent routes"})
		return false
	}
	if _, ok := raw["dcaGroupId"]; ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "raw DCA group identifier is private; use dcaGroupLockId on v2 intent routes"})
		return false
	}
	if roundsRaw, ok := raw["rounds"]; ok {
		var rounds []map[string]json.RawMessage
		if err := json.Unmarshal(roundsRaw, &rounds); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid rounds: %v", err)})
			return false
		}
		for i, round := range rounds {
			for _, field := range []string{"nonce", "nullifier", "scheduledLo", "scheduledHi", "dcaGroupId", "dcaGroupLockId"} {
				if _, ok := round[field]; ok {
					c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("round %d plaintext witness field %q is not accepted on v2 intent routes", i, field)})
					return false
				}
			}
		}
	}
	if err := json.Unmarshal(data, dest); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return false
	}
	return true
}

func parseIntentKind(raw string) domain.IntentKind {
	switch domain.IntentKind(raw) {
	case domain.KindLimit, domain.KindMarket, domain.KindDCA:
		return domain.IntentKind(raw)
	}
	if raw == domain.OnChainKindOrderFill {
		return domain.KindLimit
	}
	return ""
}

func parseOrderIntentKind(raw string) domain.IntentKind {
	switch domain.IntentKind(raw) {
	case domain.KindLimit, domain.KindMarket:
		return domain.IntentKind(raw)
	}
	if raw == domain.OnChainKindOrderFill {
		return domain.KindLimit
	}
	return ""
}

func parseChainID(c *gin.Context) int64 {
	defaultStr := strconv.FormatInt(config.DefaultChainID, 10)
	id, err := strconv.ParseInt(c.DefaultQuery("chain_id", defaultStr), 10, 64)
	if err != nil {
		return config.DefaultChainID
	}
	return id
}

func shortHash(hash string) string {
	if len(hash) <= 10 {
		return hash
	}
	return hash[:10]
}
