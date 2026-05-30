package http

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zstrategy/backend/config"
	"github.com/zstrategy/backend/internal/domain"
	"github.com/zstrategy/backend/internal/service"
)

type Handler struct {
	stats           *service.StatsService
	indexer         *service.IndexerService
	intentRepo      domain.IntentRepository
	monitor         *service.MonitorService
	keeperURL       string
	keeperAPISecret string
	httpClient      *http.Client
}

func NewHandler(
	stats *service.StatsService,
	indexer *service.IndexerService,
	intentRepo domain.IntentRepository,
	monitor *service.MonitorService,
	keeperURL string,
	keeperAPISecret string,
) *Handler {
	return &Handler{
		stats:           stats,
		indexer:         indexer,
		intentRepo:      intentRepo,
		monitor:         monitor,
		keeperURL:       keeperURL,
		keeperAPISecret: keeperAPISecret,
		httpClient:      &http.Client{Timeout: 10 * time.Second},
	}
}

// GET /health
func (h *Handler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// GET /api/v1/stats?chain_id=421614
func (h *Handler) GetStats(c *gin.Context) {
	chainID := parseChainID(c)
	stats, err := h.stats.GetStatistics(c.Request.Context(), chainID)
	if err != nil {
		errResponse(c, err)
		return
	}
	ok(c, stats)
}

// GET /api/v1/executions?chain_id=421614&kind=DCA&limit=20&offset=0
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

// POST /api/v1/intents/:hash/done
//
// Keeper-side callback: invoked when proof generation or tx submission fails
// definitively (e.g. nullifier already spent on-chain, or retry budget
// exhausted) and there is no point continuing to retry. Marks the intent as
// DONE so the monitor goroutine stops and does not re-trigger.
//
// Authenticated with the same shared bearer used for backend→keeper calls.
func (h *Handler) MarkIntentDone(c *gin.Context) {
	if h.keeperAPISecret != "" {
		auth := c.GetHeader("Authorization")
		if auth != "Bearer "+h.keeperAPISecret {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
	}

	hash := c.Param("hash")
	if hash == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing hash"})
		return
	}

	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body) // body is optional; ignore parse errors

	short := hash
	if len(short) > 10 {
		short = short[:10]
	}
	if body.Reason != "" {
		log.Printf("[Handler] keeper marked %s... DONE: %s", short, body.Reason)
	} else {
		log.Printf("[Handler] keeper marked %s... DONE", short)
	}

	ctx := c.Request.Context()
	if h.monitor != nil {
		h.monitor.UpdateStatus(ctx, hash, domain.IntentDone)
	} else if err := h.intentRepo.UpdateStatus(ctx, hash, domain.IntentDone); err != nil {
		errResponse(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// GET /api/v1/keeper/health
func (h *Handler) GetKeeperHealth(c *gin.Context) {
	health, err := h.stats.GetKeeperHealth(c.Request.Context())
	if err != nil {
		errResponse(c, err)
		return
	}
	ok(c, health)
}

// registerOrderIntentBody is the JSON body for POST /api/v1/intents/order.
type registerOrderIntentBody struct {
	CommitmentHash  string           `json:"commitmentHash"`
	Kind            string           `json:"kind"`
	ChainID         int64            `json:"chainId"`
	TokenIn         string           `json:"tokenIn"`
	TokenOut        string           `json:"tokenOut"`
	Size            string           `json:"size"`
	MinOut          string           `json:"minOut"`
	Expiry          int64            `json:"expiry"`
	LimitPrice      string           `json:"limitPrice"`
	Direction       int              `json:"direction"`
	Nonce           string           `json:"nonce"`
	Nullifier       string           `json:"nullifier"`
	EncryptedShares []encryptedShare `json:"encryptedShares"`
}

type encryptedShare struct {
	KeeperID   string `json:"keeperId"`
	Ciphertext string `json:"ciphertext"`
}

type sharesPayload struct {
	CommitmentHashes []string         `json:"commitmentHashes"`
	EncryptedShares  []encryptedShare `json:"encryptedShares"`
}

// POST /api/v1/intents/order
func (h *Handler) RegisterOrderIntent(c *gin.Context) {
	var body registerOrderIntentBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}

	if body.CommitmentHash == "" || body.TokenIn == "" || body.TokenOut == "" ||
		body.Size == "" || body.MinOut == "" || body.Nonce == "" || body.Nullifier == "" {
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
	limitPrice := body.LimitPrice
	if limitPrice == "" {
		limitPrice = "0"
	}

	s := &domain.PendingIntent{
		CommitmentHash: body.CommitmentHash,
		ChainID:        body.ChainID,
		Kind:           kind,
		TokenIn:        body.TokenIn,
		TokenOut:       body.TokenOut,
		Size:           body.Size,
		MinOut:         body.MinOut,
		Expiry:         body.Expiry,
		LimitPrice:     limitPrice,
		Direction:      body.Direction,
		Nonce:          body.Nonce,
		Nullifier:      body.Nullifier,
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

	if len(body.EncryptedShares) > 0 {
		go func() {
			if err := h.forwardSharesToKeeper([]string{body.CommitmentHash}, body.EncryptedShares); err != nil {
				log.Printf("[Handler] forward shares to keeper: %v", err)
			}
		}()
	}

	// Start monitoring goroutine.
	if h.monitor != nil {
		h.monitor.StartMonitoring(c.Request.Context(), s)
	}

	c.JSON(http.StatusCreated, gin.H{"status": "accepted", "commitmentHash": body.CommitmentHash})
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

// registerDcaIntentBody is the JSON body for POST /api/v1/intents/dca.
type registerDcaIntentBody struct {
	ChainID         int64            `json:"chainId"`
	TokenIn         string           `json:"tokenIn"`
	TokenOut        string           `json:"tokenOut"`
	EncryptedShares []encryptedShare `json:"encryptedShares"`
	Rounds          []dcaRoundInput  `json:"rounds"`
}

type dcaRoundInput struct {
	CommitmentHash string `json:"commitmentHash"`
	Nonce          string `json:"nonce"`
	Nullifier      string `json:"nullifier"`
	Size           string `json:"size"`
	MinOut         string `json:"minOut"`
	Expiry         int64  `json:"expiry"`
	ScheduledLo    int64  `json:"scheduledLo"`
	ScheduledHi    int64  `json:"scheduledHi"`
	RoundIndex     int    `json:"roundIndex"`
}

// POST /api/v1/intents/dca
func (h *Handler) RegisterDcaIntent(c *gin.Context) {
	var body registerDcaIntentBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}

	if body.TokenIn == "" || body.TokenOut == "" || len(body.Rounds) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing required fields"})
		return
	}

	ctx := c.Request.Context()
	saved := 0
	for _, round := range body.Rounds {
		lo := round.ScheduledLo
		hi := round.ScheduledHi
		s := &domain.PendingIntent{
			CommitmentHash: round.CommitmentHash,
			ChainID:        body.ChainID,
			Kind:           domain.KindDCA,
			TokenIn:        body.TokenIn,
			TokenOut:       body.TokenOut,
			Size:           round.Size,
			MinOut:         round.MinOut,
			Expiry:         round.Expiry,
			LimitPrice:     "0",
			Direction:      0,
			Nonce:          round.Nonce,
			Nullifier:      round.Nullifier,
			ScheduledLo:    &lo,
			ScheduledHi:    &hi,
			Status:         domain.IntentPending,
		}
		if err := h.intentRepo.Save(ctx, s); err != nil {
			log.Printf("[Handler] save DCA round %d: %v", round.RoundIndex, err)
			continue
		}
		if h.monitor != nil {
			h.monitor.StartMonitoring(ctx, s)
		}
		saved++
	}

	// Forward shares once for the whole group with all round hashes. The keeper's
	// share store is keyed on commitmentHash, and reconstruction at /api/execute
	// looks up by the round-specific hash, so we have to fan out across rounds —
	// but a single HTTP call carrying the array is enough.
	if len(body.EncryptedShares) > 0 && len(body.Rounds) > 0 {
		hashes := make([]string, 0, len(body.Rounds))
		for _, round := range body.Rounds {
			hashes = append(hashes, round.CommitmentHash)
		}
		go func() {
			if err := h.forwardSharesToKeeper(hashes, body.EncryptedShares); err != nil {
				log.Printf("[Handler] forward DCA shares to keeper: %v", err)
			}
		}()
	}

	c.JSON(http.StatusCreated, gin.H{"status": "accepted", "saved": saved})
}

func (h *Handler) forwardSharesToKeeper(commitmentHashes []string, shares []encryptedShare) error {
	payload := sharesPayload{
		CommitmentHashes: commitmentHashes,
		EncryptedShares:  shares,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal shares payload: %w", err)
	}

	url := strings.TrimRight(h.keeperURL, "/") + "/api/shares"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build shares request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if h.keeperAPISecret != "" {
		req.Header.Set("Authorization", "Bearer "+h.keeperAPISecret)
	}
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("forward shares to keeper: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("keeper /api/shares returned %d", resp.StatusCode)
	}
	return nil
}

func parseChainID(c *gin.Context) int64 {
	defaultStr := strconv.FormatInt(config.DefaultChainID, 10)
	id, err := strconv.ParseInt(c.DefaultQuery("chain_id", defaultStr), 10, 64)
	if err != nil {
		return config.DefaultChainID
	}
	return id
}
