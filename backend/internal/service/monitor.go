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
	"github.com/zstrategy/backend/internal/infrastructure/metrics"
)

// registryPriceFeedABI exposes CommitmentRegistry.priceFeeds(address) → address.
const registryPriceFeedABI = `[{"name":"priceFeeds","type":"function","inputs":[{"name":"token","type":"address"}],"outputs":[{"name":"","type":"address"}]}]`

// chainlinkAggregatorABI covers latestRoundData() and decimals() on any Chainlink feed.
const chainlinkAggregatorABI = `[
  {"name":"latestRoundData","type":"function","inputs":[],"outputs":[{"name":"roundId","type":"uint80"},{"name":"answer","type":"int256"},{"name":"startedAt","type":"uint256"},{"name":"updatedAt","type":"uint256"},{"name":"answeredInRound","type":"uint80"}]},
  {"name":"decimals","type":"function","inputs":[],"outputs":[{"name":"","type":"uint8"}]}
]`

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

// trackedMonitor pairs a goroutine's cancel func with the strategy kind so we
// can decrement the right Prometheus gauge label when monitoring stops.
type trackedMonitor struct {
	cancel context.CancelFunc
	kind   domain.CommitmentKind
}

type MonitorService struct {
	repo            domain.StrategyRepository
	ethClient       *ethclient.Client
	registryAddr    common.Address
	hasRegistry     bool
	regABI          abi.ABI // priceFeeds(address)
	feedABI         abi.ABI // latestRoundData() + decimals()
	keeperURL       string
	keeperAPISecret string
	httpClient      *http.Client

	mu        sync.Mutex
	stopChans map[string]trackedMonitor

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
	registryAddress string,
	keeperURL string,
	keeperAPISecret string,
) *MonitorService {
	regABI, _  := abi.JSON(strings.NewReader(registryPriceFeedABI))
	feedABI, _ := abi.JSON(strings.NewReader(chainlinkAggregatorABI))

	hasRegistry := registryAddress != "" && ethClient != nil
	var addr common.Address
	if hasRegistry {
		addr = common.HexToAddress(registryAddress)
	}
	if !hasRegistry {
		log.Println("[Monitor] COMMITMENT_REGISTRY_ADDRESS not configured — ORDER_FILL monitoring disabled")
	}
	return &MonitorService{
		repo:            repo,
		ethClient:       ethClient,
		registryAddr:    addr,
		hasRegistry:     hasRegistry,
		regABI:          regABI,
		feedABI:         feedABI,
		keeperURL:       keeperURL,
		keeperAPISecret: keeperAPISecret,
		httpClient:      &http.Client{Timeout: 10 * time.Second},
		stopChans:       make(map[string]trackedMonitor),
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
	if tm, ok := m.stopChans[commitmentHash]; ok {
		tm.cancel()
		delete(m.stopChans, commitmentHash)
		metrics.PendingStrategies.WithLabelValues(string(tm.kind)).Dec()
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
	m.stopChans[s.CommitmentHash] = trackedMonitor{cancel: cancel, kind: s.Kind}
	metrics.PendingStrategies.WithLabelValues(string(s.Kind)).Inc()

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
	evalStart := time.Now()
	defer func() {
		metrics.MonitorEvalDuration.WithLabelValues(string(s.Kind)).Observe(time.Since(evalStart).Seconds())
	}()
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
	if s.Kind == domain.KindMarket {
		// MARKET: fires on first goroutine tick. No oracle poll, no time window —
		// the on-chain commitment uses a sentinel limit price (u64.max for BUY,
		// 0 for SELL) that trivially satisfies the circuit's fill check; the
		// keeper still does its own oracle re-verify and will see the same
		// trivial pass.
		return true, nil
	}
	if s.Kind == domain.KindDCA {
		if s.ScheduledLo == nil || s.ScheduledHi == nil {
			return false, nil
		}
		return now >= *s.ScheduledLo && now <= *s.ScheduledHi, nil
	}

	// ORDER_FILL: derive pair price from two registry-registered Chainlink feeds.
	if !m.hasRegistry {
		return false, nil
	}

	oraclePrice, err := m.fetchPairPrice(ctx, s.TokenIn, s.TokenOut)
	if err != nil {
		return false, fmt.Errorf("pair price: %w", err)
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

// fetchPairPrice mirrors CommitmentRegistry._readOraclePrice:
//
//	normIn  = answerIn  * 10^(18 - dIn)
//	normOut = answerOut * 10^(18 - dOut)
//	priceU  = normIn * 10^dOut / normOut   (dOut decimal places)
func (m *MonitorService) fetchPairPrice(ctx context.Context, tokenIn, tokenOut string) (*big.Int, error) {
	addrIn  := common.HexToAddress(tokenIn)
	addrOut := common.HexToAddress(tokenOut)

	feedInAddr, err := m.callRegistryPriceFeed(ctx, addrIn)
	if err != nil {
		return nil, fmt.Errorf("priceFeeds(tokenIn): %w", err)
	}
	if feedInAddr == (common.Address{}) {
		return nil, fmt.Errorf("no USD feed configured for tokenIn %s", tokenIn)
	}

	feedOutAddr, err := m.callRegistryPriceFeed(ctx, addrOut)
	if err != nil {
		return nil, fmt.Errorf("priceFeeds(tokenOut): %w", err)
	}
	if feedOutAddr == (common.Address{}) {
		return nil, fmt.Errorf("no USD feed configured for tokenOut %s", tokenOut)
	}

	answerIn, dIn, err := m.callChainlinkFeed(ctx, feedInAddr)
	if err != nil {
		return nil, fmt.Errorf("tokenIn feed: %w", err)
	}

	answerOut, dOut, err := m.callChainlinkFeed(ctx, feedOutAddr)
	if err != nil {
		return nil, fmt.Errorf("tokenOut feed: %w", err)
	}

	ten := big.NewInt(10)
	normIn  := new(big.Int).Mul(answerIn,  new(big.Int).Exp(ten, big.NewInt(int64(18-dIn)),  nil))
	normOut := new(big.Int).Mul(answerOut, new(big.Int).Exp(ten, big.NewInt(int64(18-dOut)), nil))
	priceU  := new(big.Int).Div(
		new(big.Int).Mul(normIn, new(big.Int).Exp(ten, big.NewInt(int64(dOut)), nil)),
		normOut,
	)

	if priceU.Sign() <= 0 {
		return nil, fmt.Errorf("derived pair price is zero")
	}
	return priceU, nil
}

func (m *MonitorService) callRegistryPriceFeed(ctx context.Context, token common.Address) (common.Address, error) {
	packed, err := m.regABI.Pack("priceFeeds", token)
	if err != nil {
		return common.Address{}, fmt.Errorf("pack: %w", err)
	}

	result, err := m.ethClient.CallContract(ctx, ethereum.CallMsg{To: &m.registryAddr, Data: packed}, nil)
	if err != nil {
		return common.Address{}, fmt.Errorf("call: %w", err)
	}

	out, err := m.regABI.Unpack("priceFeeds", result)
	if err != nil {
		return common.Address{}, fmt.Errorf("unpack: %w", err)
	}

	addr, ok := out[0].(common.Address)
	if !ok {
		return common.Address{}, fmt.Errorf("unexpected return type")
	}
	return addr, nil
}

func (m *MonitorService) callChainlinkFeed(ctx context.Context, feedAddr common.Address) (answer *big.Int, decimals uint8, err error) {
	// latestRoundData
	packed, err := m.feedABI.Pack("latestRoundData")
	if err != nil {
		return nil, 0, fmt.Errorf("pack latestRoundData: %w", err)
	}
	result, err := m.ethClient.CallContract(ctx, ethereum.CallMsg{To: &feedAddr, Data: packed}, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("call latestRoundData: %w", err)
	}
	out, err := m.feedABI.Unpack("latestRoundData", result)
	if err != nil {
		return nil, 0, fmt.Errorf("unpack latestRoundData: %w", err)
	}
	ans, ok := out[1].(*big.Int)
	if !ok || ans.Sign() <= 0 {
		return nil, 0, fmt.Errorf("non-positive oracle price from feed %s", feedAddr)
	}

	// decimals
	packed, err = m.feedABI.Pack("decimals")
	if err != nil {
		return nil, 0, fmt.Errorf("pack decimals: %w", err)
	}
	result, err = m.ethClient.CallContract(ctx, ethereum.CallMsg{To: &feedAddr, Data: packed}, nil)
	if err != nil {
		return nil, 0, fmt.Errorf("call decimals: %w", err)
	}
	out, err = m.feedABI.Unpack("decimals", result)
	if err != nil {
		return nil, 0, fmt.Errorf("unpack decimals: %w", err)
	}
	dec, ok := out[0].(uint8)
	if !ok {
		return nil, 0, fmt.Errorf("unexpected decimals type from feed %s", feedAddr)
	}

	return ans, dec, nil
}

func (m *MonitorService) triggerKeeper(s *domain.PendingStrategy) {
	// On the wire, MARKET is indistinguishable from ORDER_FILL: same circuit,
	// same verifier, same on-chain kind=0. The keeper's oracle re-verify
	// trivially passes against the sentinel limit price.
	wireKind := s.Kind
	if wireKind == domain.KindMarket {
		wireKind = domain.KindOrderFill
	}
	payload := executeRequest{
		CommitmentHash: s.CommitmentHash,
		Kind:           string(wireKind),
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
		metrics.KeeperTriggerTotal.WithLabelValues("error").Inc()
		log.Printf("[Monitor] POST %s failed for %s...: %v", url, s.CommitmentHash[:10], err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusOK {
		metrics.KeeperTriggerTotal.WithLabelValues("accepted").Inc()
		log.Printf("[Monitor] keeper accepted trigger for %s... (status=%d)", s.CommitmentHash[:10], resp.StatusCode)
		return
	}

	// Keeper rejected (most commonly 422 fill-condition mismatch or 503 oracle
	// unavailable). The execution did NOT happen on-chain — reset to PENDING
	// and resume monitoring so the next tick can retry. Without this, the row
	// would sit in EXECUTING until the periodic sweeper picks it up.
	metrics.KeeperTriggerTotal.WithLabelValues("rejected").Inc()
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
