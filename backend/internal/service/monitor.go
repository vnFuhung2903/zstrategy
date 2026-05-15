package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/zstrategy/backend/internal/domain"
)

const chainlinkABI = `[{"name":"latestRoundData","type":"function","inputs":[],"outputs":[{"name":"roundId","type":"uint80"},{"name":"answer","type":"int256"},{"name":"startedAt","type":"uint256"},{"name":"updatedAt","type":"uint256"},{"name":"answeredInRound","type":"uint80"}]}]`

const (
	monitorTickInterval = 30 * time.Second
	// Stuck-EXECUTING sweeper: any row sitting in EXECUTING longer than this is
	// presumed orphaned (keeper crashed mid-flight or trigger was never accepted)
	// and gets reset to PENDING. The chain indexer is authoritative for genuine
	// completion (it flips status to DONE on CommitmentExecuted), so a duplicate
	// trigger after reset is harmless — the on-chain nullifier check rejects it.
	stuckExecutingThreshold = 10 * time.Minute
	stuckSweepInterval      = 5 * time.Minute
)

// executeRequest mirrors the JSON body sent to keeper POST /api/execute.
type executeRequest struct {
	CommitmentHash string  `json:"commitmentHash"`
	Kind           string  `json:"kind"`
	TokenIn        string  `json:"tokenIn"`
	TokenOut       string  `json:"tokenOut"`
	Size           string  `json:"size"`
	MinOut         string  `json:"minOut"`
	Expiry         int64   `json:"expiry"`
	LimitPrice     string  `json:"limitPrice"`
	Direction      int     `json:"direction"`
	Nonce          string  `json:"nonce"`
	Nullifier      string  `json:"nullifier"`
	ScheduledLo    *int64  `json:"scheduledLo"`
	ScheduledHi    *int64  `json:"scheduledHi"`
}

type MonitorService struct {
	repo            domain.StrategyRepository
	ethClient       *ethclient.Client
	feedAddr        common.Address
	hasFeed         bool
	parsedABI       abi.ABI
	keeperURL       string
	keeperAPISecret string
	httpClient      *http.Client

	mu       sync.Mutex
	stopChans map[string]context.CancelFunc

	// rootCtx is the long-lived context goroutines should be derived from. It
	// is set by RehydrateFromDB at startup. Per-request contexts (e.g. from a
	// gin handler) cancel when the response is written and would prematurely
	// kill the monitor goroutine, so we ignore caller ctx for goroutine
	// lifetime purposes once rootCtx is set.
	rootCtx context.Context
}

func NewMonitorService(
	repo domain.StrategyRepository,
	ethClient *ethclient.Client,
	feedAddress string,
	keeperURL string,
	keeperAPISecret string,
) *MonitorService {
	parsed, _ := abi.JSON(strings.NewReader(chainlinkABI))
	hasFeed := feedAddress != "" && ethClient != nil
	var addr common.Address
	if hasFeed {
		addr = common.HexToAddress(feedAddress)
	}
	if !hasFeed {
		log.Println("[Monitor] CHAINLINK_ETH_USD not configured — ORDER_FILL monitoring disabled")
	}
	return &MonitorService{
		repo:            repo,
		ethClient:       ethClient,
		feedAddr:        addr,
		hasFeed:         hasFeed,
		parsedABI:       parsed,
		keeperURL:       keeperURL,
		keeperAPISecret: keeperAPISecret,
		httpClient:      &http.Client{Timeout: 10 * time.Second},
		stopChans:       make(map[string]context.CancelFunc),
	}
}

// RehydrateFromDB restarts monitoring goroutines for all PENDING strategies
// on backend startup. It first resets any rows still in EXECUTING (orphaned by
// a previous crash mid-flight) back to PENDING so they are picked up too. The
// passed context is also captured as the long-lived root for goroutines
// spawned by later HTTP-triggered StartMonitoring calls.
func (m *MonitorService) RehydrateFromDB(ctx context.Context) {
	m.rootCtx = ctx
	// Reset all stuck EXECUTING rows on startup (olderThan=0 means reset all).
	// On a fresh boot, anything still EXECUTING means a previous keeper/backend
	// crashed before the chain indexer flipped it to DONE.
	if reset, err := m.repo.ResetStuckExecuting(ctx, 0); err != nil {
		log.Printf("[Monitor] reset stuck on rehydrate: %v", err)
	} else if len(reset) > 0 {
		log.Printf("[Monitor] reset %d orphaned EXECUTING rows to PENDING", len(reset))
	}

	strategies, err := m.repo.ListPending(ctx)
	if err != nil {
		log.Printf("[Monitor] rehydrate error: %v", err)
		return
	}
	for _, s := range strategies {
		m.startMonitoring(ctx, s)
	}
	log.Printf("[Monitor] rehydrated %d pending strategies", len(strategies))
}

// StartStuckSweeper runs a periodic sweeper that resets EXECUTING rows older
// than `stuckExecutingThreshold` back to PENDING, then re-monitors them. Call
// once after RehydrateFromDB; the goroutine exits when ctx is cancelled.
func (m *MonitorService) StartStuckSweeper(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(stuckSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.sweepStuckExecuting(ctx)
			}
		}
	}()
}

func (m *MonitorService) sweepStuckExecuting(ctx context.Context) {
	reset, err := m.repo.ResetStuckExecuting(ctx, stuckExecutingThreshold)
	if err != nil {
		log.Printf("[Monitor] sweep stuck executing: %v", err)
		return
	}
	if len(reset) == 0 {
		return
	}
	log.Printf("[Monitor] sweep reset %d stuck EXECUTING rows; resuming monitoring", len(reset))
	for _, s := range reset {
		m.startMonitoring(ctx, s)
	}
}

// StartMonitoring begins fill-condition polling for a strategy.
func (m *MonitorService) StartMonitoring(ctx context.Context, s *domain.PendingStrategy) {
	m.startMonitoring(ctx, s)
}

// StopMonitoring stops the goroutine for a given commitment hash.
func (m *MonitorService) StopMonitoring(commitmentHash string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if cancel, ok := m.stopChans[commitmentHash]; ok {
		cancel()
		delete(m.stopChans, commitmentHash)
	}
}

// UpdateStatus updates a strategy's status in the DB and stops monitoring if done.
func (m *MonitorService) UpdateStatus(ctx context.Context, commitmentHash string, status domain.StrategyStatus) {
	if err := m.repo.UpdateStatus(ctx, commitmentHash, status); err != nil {
		log.Printf("[Monitor] UpdateStatus %s: %v", commitmentHash[:10], err)
	}
	if status == domain.StrategyDone {
		m.StopMonitoring(commitmentHash)
	}
}

func (m *MonitorService) startMonitoring(ctx context.Context, s *domain.PendingStrategy) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.stopChans[s.CommitmentHash]; exists {
		return // already watching
	}

	// Goroutine lifetime must follow the long-lived root context, not the
	// caller's (which may be a gin request context that cancels immediately).
	parent := m.rootCtx
	if parent == nil {
		parent = ctx
	}
	childCtx, cancel := context.WithCancel(parent)
	m.stopChans[s.CommitmentHash] = cancel

	go m.monitorLoop(childCtx, s)
}

func (m *MonitorService) monitorLoop(ctx context.Context, s *domain.PendingStrategy) {
	ticker := time.NewTicker(monitorTickInterval)
	defer ticker.Stop()

	short := s.CommitmentHash
	if len(short) > 10 {
		short = short[:10]
	}

	log.Printf("[Monitor] started goroutine for %s... (kind=%s)", short, s.Kind)

	// Evaluate immediately on start, then on each tick.
	m.evaluateAndMaybeTrigger(ctx, s)

	for {
		select {
		case <-ctx.Done():
			log.Printf("[Monitor] stopped goroutine for %s...", short)
			return
		case <-ticker.C:
			m.evaluateAndMaybeTrigger(ctx, s)
		}
	}
}

func (m *MonitorService) evaluateAndMaybeTrigger(ctx context.Context, s *domain.PendingStrategy) {
	now := time.Now().Unix()

	// Check expiry.
	if s.Expiry > 0 && now > s.Expiry {
		log.Printf("[Monitor] %s... expired — stopping", s.CommitmentHash[:10])
		m.UpdateStatus(ctx, s.CommitmentHash, domain.StrategyDone)
		return
	}

	met, err := m.isFillConditionMet(ctx, s, now)
	if err != nil {
		log.Printf("[Monitor] condition check error for %s...: %v", s.CommitmentHash[:10], err)
		return
	}
	if !met {
		return
	}

	log.Printf("[Monitor] fill condition MET for %s... — triggering keeper", s.CommitmentHash[:10])

	// Mark EXECUTING before firing so concurrent ticks don't re-trigger.
	if err := m.repo.UpdateStatus(ctx, s.CommitmentHash, domain.StrategyExecuting); err != nil {
		log.Printf("[Monitor] UpdateStatus EXECUTING %s...: %v", s.CommitmentHash[:10], err)
		return
	}
	m.StopMonitoring(s.CommitmentHash)

	go m.triggerKeeper(s)
}

func (m *MonitorService) isFillConditionMet(ctx context.Context, s *domain.PendingStrategy, now int64) (bool, error) {
	if s.Kind == domain.KindDCA {
		if s.ScheduledLo == nil || s.ScheduledHi == nil {
			return false, nil
		}
		return now >= *s.ScheduledLo && now <= *s.ScheduledHi, nil
	}

	// ORDER_FILL: needs Chainlink price.
	if !m.hasFeed {
		return false, nil
	}

	oraclePrice, err := m.fetchChainlinkPrice(ctx)
	if err != nil {
		return false, fmt.Errorf("chainlink fetch: %w", err)
	}

	limitPrice := new(big.Int)
	if _, ok := limitPrice.SetString(s.LimitPrice, 10); !ok {
		return false, fmt.Errorf("invalid limit_price: %s", s.LimitPrice)
	}

	// direction: 0 = BUY (fill when oracle <= limit), 1 = SELL (fill when oracle >= limit)
	if s.Direction == 1 {
		return oraclePrice.Cmp(limitPrice) >= 0, nil
	}
	return oraclePrice.Cmp(limitPrice) <= 0, nil
}

func (m *MonitorService) fetchChainlinkPrice(ctx context.Context) (*big.Int, error) {
	packed, err := m.parsedABI.Pack("latestRoundData")
	if err != nil {
		return nil, fmt.Errorf("pack call: %w", err)
	}

	msg := ethereum.CallMsg{
		To:   &m.feedAddr,
		Data: packed,
	}

	result, err := m.ethClient.CallContract(ctx, msg, nil)
	if err != nil {
		return nil, fmt.Errorf("call contract: %w", err)
	}

	out, err := m.parsedABI.Unpack("latestRoundData", result)
	if err != nil {
		return nil, fmt.Errorf("unpack result: %w", err)
	}
	if len(out) < 2 {
		return nil, fmt.Errorf("unexpected output length: %d", len(out))
	}

	answer, ok := out[1].(*big.Int)
	if !ok {
		return nil, fmt.Errorf("unexpected answer type")
	}
	if answer.Sign() <= 0 {
		return nil, fmt.Errorf("non-positive oracle price")
	}
	return answer, nil
}

func (m *MonitorService) triggerKeeper(s *domain.PendingStrategy) {
	payload := executeRequest{
		CommitmentHash: s.CommitmentHash,
		Kind:           string(s.Kind),
		TokenIn:        s.TokenIn,
		TokenOut:       s.TokenOut,
		Size:           s.Size,
		MinOut:         s.MinOut,
		Expiry:         s.Expiry,
		LimitPrice:     s.LimitPrice,
		Direction:      s.Direction,
		Nonce:          s.Nonce,
		Nullifier:      s.Nullifier,
		ScheduledLo:    s.ScheduledLo,
		ScheduledHi:    s.ScheduledHi,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[Monitor] marshal trigger payload: %v", err)
		return
	}

	url := strings.TrimRight(m.keeperURL, "/") + "/api/execute"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		log.Printf("[Monitor] build trigger request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if m.keeperAPISecret != "" {
		req.Header.Set("Authorization", "Bearer "+m.keeperAPISecret)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		log.Printf("[Monitor] POST %s failed for %s...: %v", url, s.CommitmentHash[:10], err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusOK {
		log.Printf("[Monitor] keeper accepted trigger for %s... (status=%d)", s.CommitmentHash[:10], resp.StatusCode)
		return
	}

	// Keeper rejected (most commonly 422 fill-condition mismatch or 503 oracle
	// unavailable). The execution did NOT happen on-chain — reset to PENDING
	// and resume monitoring so the next tick can retry. Without this, the row
	// would sit in EXECUTING until the periodic sweeper picks it up.
	log.Printf("[Monitor] keeper rejected trigger for %s... (status=%d) — resuming monitor", s.CommitmentHash[:10], resp.StatusCode)
	rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.repo.UpdateStatus(rollbackCtx, s.CommitmentHash, domain.StrategyPending); err != nil {
		log.Printf("[Monitor] reset to PENDING after rejection: %v", err)
		return
	}
	s.Status = domain.StrategyPending
	m.startMonitoring(context.Background(), s)
}
