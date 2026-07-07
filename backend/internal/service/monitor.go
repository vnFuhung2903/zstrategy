package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strconv"
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

const registryReadABI = `[
  {"name":"priceFeeds","type":"function","inputs":[{"name":"token","type":"address"}],"outputs":[{"name":"","type":"address"}]},
  {"name":"getCommitmentStatus","type":"function","inputs":[{"name":"commitmentHash","type":"bytes32"}],"outputs":[{"name":"","type":"uint8"}]},
  {"name":"executeCommitment","type":"function","inputs":[{"name":"commitmentHash","type":"bytes32"},{"name":"nullifier","type":"bytes32"},{"name":"proof","type":"bytes"},{"name":"fillRef","type":"uint64"},{"name":"receipt","type":"tuple","components":[{"name":"proverId","type":"bytes32"},{"name":"ticketExpiresAt","type":"uint64"},{"name":"signature","type":"bytes"}]}],"outputs":[]}
]`

const chainlinkAggregatorABI = `[
  {"name":"latestRoundData","type":"function","inputs":[],"outputs":[{"name":"roundId","type":"uint80"},{"name":"answer","type":"int256"},{"name":"startedAt","type":"uint256"},{"name":"updatedAt","type":"uint256"},{"name":"answeredInRound","type":"uint80"}]},
  {"name":"decimals","type":"function","inputs":[],"outputs":[{"name":"","type":"uint8"}]}
]`

const (
	monitorTickInterval     = 30 * time.Second
	stuckExecutingThreshold = 10 * time.Minute
	stuckSweepInterval      = 5 * time.Minute
	commitmentStatusPending = uint8(1)
	claimSimulationGasLimit = uint64(200_000_000)
)

type trackedMonitor struct {
	cancel context.CancelFunc
	kind   domain.IntentKind
}

type MonitorService struct {
	repo         domain.IntentRepository
	ethClient    *ethclient.Client
	registryAddr common.Address
	hasRegistry  bool
	regABI       abi.ABI
	feedABI      abi.ABI
	enclave      EnclaveClient

	fetchPairPriceFn     func(context.Context, string, string) (*big.Int, error)
	isOnChainPendingFn   func(context.Context, string) (bool, error)
	latestBlockContextFn func(context.Context, int64) (string, int64, error)

	mu                  sync.Mutex
	stopChans           map[string]trackedMonitor
	activeDcaGroupLocks map[string]string
	rootCtx             context.Context
}

type TicketClaimCheck struct {
	Executable        bool
	CommitmentPending bool
	Reason            string
}

type proverReceiptCall struct {
	ProverId        common.Hash
	TicketExpiresAt uint64
	Signature       []byte
}

func NewMonitorService(
	repo domain.IntentRepository,
	ethClient *ethclient.Client,
	registryAddress string,
	enclave EnclaveClient,
) *MonitorService {
	regABI, _ := abi.JSON(strings.NewReader(registryReadABI))
	feedABI, _ := abi.JSON(strings.NewReader(chainlinkAggregatorABI))

	hasRegistry := registryAddress != "" && ethClient != nil
	var addr common.Address
	if hasRegistry {
		addr = common.HexToAddress(registryAddress)
	}
	if !hasRegistry {
		log.Println("[Monitor] COMMITMENT_REGISTRY_ADDRESS or RPC_URL not configured; scheduler will not publish tickets")
	}

	m := &MonitorService{
		repo:                repo,
		ethClient:           ethClient,
		registryAddr:        addr,
		hasRegistry:         hasRegistry,
		regABI:              regABI,
		feedABI:             feedABI,
		enclave:             enclave,
		stopChans:           make(map[string]trackedMonitor),
		activeDcaGroupLocks: make(map[string]string),
	}
	m.fetchPairPriceFn = m.fetchPairPrice
	m.isOnChainPendingFn = m.isCommitmentPendingOnChain
	m.latestBlockContextFn = m.latestBlockContext
	return m
}

func (m *MonitorService) RehydrateFromDB(ctx context.Context) {
	m.rootCtx = ctx

	if reset, err := m.repo.ResetStuckExecuting(ctx, 0); err != nil {
		log.Printf("[Monitor] reset stuck on rehydrate: %v", err)
	} else if len(reset) > 0 {
		log.Printf("[Monitor] reset %d orphaned EVALUATING rows to PENDING", len(reset))
	}

	if reset, err := m.repo.ResetExpiredTickets(ctx, time.Now()); err != nil {
		log.Printf("[Monitor] reset expired tickets on rehydrate: %v", err)
	} else if len(reset) > 0 {
		log.Printf("[Monitor] reset %d expired tickets to PENDING", len(reset))
	}

	intents, err := m.repo.ListPending(ctx)
	if err != nil {
		log.Printf("[Monitor] rehydrate error: %v", err)
		return
	}
	for _, s := range intents {
		m.startMonitoring(ctx, s)
	}
	log.Printf("[Monitor] rehydrated %d pending intents", len(intents))
}

func (m *MonitorService) StartStuckSweeper(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(stuckSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.sweepRetryable(ctx)
			}
		}
	}()
}

func (m *MonitorService) sweepRetryable(ctx context.Context) {
	reset, err := m.repo.ResetStuckExecuting(ctx, stuckExecutingThreshold)
	if err != nil {
		log.Printf("[Monitor] sweep stuck evaluating: %v", err)
		return
	}
	expiredTickets, err := m.repo.ResetExpiredTickets(ctx, time.Now())
	if err != nil {
		log.Printf("[Monitor] sweep expired tickets: %v", err)
		return
	}

	reset = append(reset, expiredTickets...)
	if len(reset) == 0 {
		return
	}
	log.Printf("[Monitor] resumed %d retryable intents", len(reset))
	for _, s := range reset {
		m.StopMonitoring(s.CommitmentHash)
		m.startMonitoring(ctx, s)
	}
}

func (m *MonitorService) StartMonitoring(ctx context.Context, s *domain.PendingIntent) {
	m.startMonitoring(ctx, s)
}

func (m *MonitorService) StopMonitoring(commitmentHash string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if tm, ok := m.stopChans[commitmentHash]; ok {
		tm.cancel()
		delete(m.stopChans, commitmentHash)
		metrics.PendingIntents.WithLabelValues(string(tm.kind)).Dec()
	}
}

func (m *MonitorService) tryLockDcaGroup(s *domain.PendingIntent) (func(), bool) {
	if s.Kind != domain.KindDCA || s.DCAGroupLockID == "" {
		return func() {}, true
	}

	lockID := strings.ToLower(s.DCAGroupLockID)
	m.mu.Lock()
	defer m.mu.Unlock()

	if active, exists := m.activeDcaGroupLocks[lockID]; exists && !strings.EqualFold(active, s.CommitmentHash) {
		log.Printf("[Monitor] defer %s... because DCA group lock %s... is already proving", shortHash(s.CommitmentHash), shortHash(lockID))
		return nil, false
	}
	m.activeDcaGroupLocks[lockID] = s.CommitmentHash

	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if strings.EqualFold(m.activeDcaGroupLocks[lockID], s.CommitmentHash) {
			delete(m.activeDcaGroupLocks, lockID)
		}
	}, true
}

func (m *MonitorService) UpdateStatus(ctx context.Context, commitmentHash string, status domain.IntentStatus) {
	if err := m.repo.UpdateStatus(ctx, commitmentHash, status); err != nil {
		log.Printf("[Monitor] UpdateStatus %s: %v", shortHash(commitmentHash), err)
	}
	if status == domain.IntentDone || status == domain.IntentFailed {
		m.StopMonitoring(commitmentHash)
	}
}

func (m *MonitorService) startMonitoring(ctx context.Context, s *domain.PendingIntent) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.stopChans[s.CommitmentHash]; exists {
		return
	}

	parent := m.rootCtx
	if parent == nil {
		parent = ctx
	}
	childCtx, cancel := context.WithCancel(parent)
	m.stopChans[s.CommitmentHash] = trackedMonitor{cancel: cancel, kind: s.Kind}
	metrics.PendingIntents.WithLabelValues(string(s.Kind)).Inc()

	go m.monitorLoop(childCtx, s)
}

func (m *MonitorService) monitorLoop(ctx context.Context, s *domain.PendingIntent) {
	ticker := time.NewTicker(monitorTickInterval)
	defer ticker.Stop()

	log.Printf("[Monitor] started scheduler for %s... (kind=%s)", shortHash(s.CommitmentHash), s.Kind)
	m.evaluateAndMaybeTicket(ctx, s)

	for {
		select {
		case <-ctx.Done():
			log.Printf("[Monitor] stopped scheduler for %s...", shortHash(s.CommitmentHash))
			return
		case <-ticker.C:
			m.evaluateAndMaybeTicket(ctx, s)
		}
	}
}

func (m *MonitorService) evaluateAndMaybeTicket(ctx context.Context, s *domain.PendingIntent) {
	evalStart := time.Now()
	defer func() {
		metrics.MonitorEvalDuration.WithLabelValues(string(s.Kind)).Observe(time.Since(evalStart).Seconds())
	}()

	if ctx.Err() != nil {
		return
	}

	now := time.Now().Unix()
	if s.Expiry > 0 && now > s.Expiry {
		log.Printf("[Monitor] %s... expired locally; waiting for on-chain sweep event", shortHash(s.CommitmentHash))
		m.UpdateStatus(ctx, s.CommitmentHash, domain.IntentDone)
		_ = m.pruneEnclave(ctx, s.CommitmentHash)
		return
	}

	if m.enclave == nil {
		log.Printf("[Monitor] enclave client not configured for %s...", shortHash(s.CommitmentHash))
		return
	}

	pending, err := m.isOnChainPendingFn(ctx, s.CommitmentHash)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		log.Printf("[Monitor] on-chain status check failed for %s...: %v", shortHash(s.CommitmentHash), err)
		return
	}
	if !pending {
		log.Printf("[Monitor] %s... is no longer on-chain pending; pruning package", shortHash(s.CommitmentHash))
		m.UpdateStatus(ctx, s.CommitmentHash, domain.IntentDone)
		_ = m.pruneEnclave(ctx, s.CommitmentHash)
		return
	}

	releaseDcaGroup, locked := m.tryLockDcaGroup(s)
	if !locked {
		return
	}
	defer releaseDcaGroup()

	claimed, err := m.repo.ClaimForEvaluation(ctx, s.CommitmentHash)
	if err != nil {
		log.Printf("[Monitor] claim evaluation %s...: %v", shortHash(s.CommitmentHash), err)
		return
	}
	if !claimed {
		return
	}

	pkg, err := decodeStoredPackage(s)
	if err != nil {
		log.Printf("[Monitor] invalid stored package for %s...: %v", shortHash(s.CommitmentHash), err)
		m.markEvaluationFailed(ctx, s.CommitmentHash, err.Error())
		m.StopMonitoring(s.CommitmentHash)
		return
	}

	if err := m.enclave.ImportPackage(ctx, pkg); err != nil {
		if ctx.Err() != nil {
			return
		}
		log.Printf("[Monitor] enclave rejected package for %s...: %v", shortHash(s.CommitmentHash), err)
		if isPermanentEnclaveImportError(err) {
			m.markEvaluationFailed(ctx, s.CommitmentHash, err.Error())
			m.StopMonitoring(s.CommitmentHash)
			return
		}
		m.resetToPending(ctx, s)
		return
	}

	fillCtx, err := m.buildFillContext(ctx, s, pkg, now)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		log.Printf("[Monitor] fill context unavailable for %s...: %v", shortHash(s.CommitmentHash), err)
		m.resetToPending(ctx, s)
		return
	}

	ticket, ready, err := m.enclave.Evaluate(ctx, s.CommitmentHash, fillCtx)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		log.Printf("[Monitor] enclave evaluate failed for %s...: %v", shortHash(s.CommitmentHash), err)
		m.resetToPending(ctx, s)
		return
	}
	if !ready {
		m.resetToPending(ctx, s)
		return
	}
	if err := validateExecutionTicket(s, pkg, fillCtx, ticket, time.Now()); err != nil {
		log.Printf("[Monitor] invalid ticket for %s...: %v", shortHash(s.CommitmentHash), err)
		if errors.Is(err, errTicketExpired) {
			m.resetToPending(ctx, s)
			return
		}
		m.markEvaluationFailed(ctx, s.CommitmentHash, err.Error())
		m.StopMonitoring(s.CommitmentHash)
		return
	}

	stillPending, err := m.isOnChainPendingFn(ctx, s.CommitmentHash)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		log.Printf("[Monitor] post-proof status check failed for %s...: %v", shortHash(s.CommitmentHash), err)
		m.resetToPending(ctx, s)
		return
	}
	if !stillPending {
		log.Printf("[Monitor] discarding ticket for finalized %s...", shortHash(s.CommitmentHash))
		m.UpdateStatus(ctx, s.CommitmentHash, domain.IntentDone)
		_ = m.pruneEnclave(ctx, s.CommitmentHash)
		return
	}

	ticketJSON, err := domain.StableJSON(ticket)
	if err != nil {
		log.Printf("[Monitor] marshal ticket %s...: %v", shortHash(s.CommitmentHash), err)
		m.resetToPending(ctx, s)
		return
	}
	if ctx.Err() != nil {
		return
	}

	expiresAt := time.Unix(ticket.TicketExpiresAt, 0)
	stored, err := m.repo.StoreTicket(ctx, s.CommitmentHash, ticketJSON, expiresAt)
	if err != nil {
		log.Printf("[Monitor] store ticket %s...: %v", shortHash(s.CommitmentHash), err)
		m.resetToPending(ctx, s)
		return
	}
	if !stored {
		log.Printf("[Monitor] ticket not stored for %s... because status changed during evaluation", shortHash(s.CommitmentHash))
		m.StopMonitoring(s.CommitmentHash)
		return
	}

	log.Printf("[Monitor] execution ticket ready for %s... (expires=%s)", shortHash(s.CommitmentHash), expiresAt.UTC().Format(time.RFC3339))
	m.StopMonitoring(s.CommitmentHash)
}

func (m *MonitorService) buildFillContext(ctx context.Context, s *domain.PendingIntent, pkg domain.EncryptedWitnessPackage, now int64) (domain.FillContext, error) {
	blockNumber, blockTimestamp, err := m.latestBlockContextFn(ctx, now)
	if err != nil {
		return domain.FillContext{}, err
	}

	fillCtx := domain.FillContext{
		ChainID:        s.ChainID,
		Registry:       s.Registry,
		BlockNumber:    blockNumber,
		BlockTimestamp: blockTimestamp,
	}

	if pkg.Kind == domain.CircuitKindOrderFill {
		oraclePrice, err := m.fetchPairPriceFn(ctx, s.TokenIn, s.TokenOut)
		if err != nil {
			return domain.FillContext{}, fmt.Errorf("pair price: %w", err)
		}
		fillCtx.OraclePrice = oraclePrice.String()
	}

	return fillCtx, nil
}

func decodeStoredPackage(s *domain.PendingIntent) (domain.EncryptedWitnessPackage, error) {
	var pkg domain.EncryptedWitnessPackage
	if err := json.Unmarshal([]byte(s.WitnessPackage), &pkg); err != nil {
		return pkg, fmt.Errorf("decode witness package: %w", err)
	}
	if err := domain.ValidateEncryptedWitnessPackage(pkg); err != nil {
		return pkg, err
	}
	if !strings.EqualFold(pkg.CommitmentHash, s.CommitmentHash) ||
		pkg.AAD.ChainID != s.ChainID ||
		!strings.EqualFold(pkg.AAD.Registry, s.Registry) ||
		!strings.EqualFold(pkg.AAD.TokenIn, s.TokenIn) ||
		!strings.EqualFold(pkg.AAD.TokenOut, s.TokenOut) ||
		!strings.EqualFold(pkg.AAD.DCAGroupLockID, s.DCAGroupLockID) ||
		pkg.AAD.Size != s.Size ||
		pkg.AAD.MinOut != s.MinOut ||
		pkg.AAD.Expiry != s.Expiry {
		return pkg, fmt.Errorf("witness package AAD does not match pending intent metadata")
	}
	return pkg, nil
}

var errTicketExpired = errors.New("execution ticket already expired")

func validateExecutionTicket(
	s *domain.PendingIntent,
	pkg domain.EncryptedWitnessPackage,
	fillCtx domain.FillContext,
	ticket *domain.ExecutionTicket,
	now time.Time,
) error {
	if ticket == nil {
		return fmt.Errorf("missing ticket")
	}
	if ticket.Version != 1 {
		return fmt.Errorf("unsupported ticket version")
	}
	if ticket.ChainID != s.ChainID ||
		!strings.EqualFold(ticket.Registry, s.Registry) ||
		!strings.EqualFold(ticket.CommitmentHash, s.CommitmentHash) ||
		ticket.Kind != pkg.Kind ||
		!strings.EqualFold(ticket.PackageHash, pkg.PackageHash) {
		return fmt.Errorf("ticket public metadata does not match pending intent")
	}
	if ticket.Proof == "" || ticket.Nullifier == "" {
		return fmt.Errorf("ticket missing proof or nullifier")
	}
	if !isHexBytes32(ticket.ProverID) {
		return fmt.Errorf("ticket missing proverId")
	}
	if !strings.EqualFold(ticket.ProverReceipt.ProverID, ticket.ProverID) ||
		ticket.ProverReceipt.TicketExpiresAt != ticket.TicketExpiresAt ||
		!isHexData(ticket.ProverReceipt.Signature) {
		return fmt.Errorf("ticket missing proverReceipt")
	}
	if ticket.TicketExpiresAt <= now.Unix() {
		return errTicketExpired
	}
	if pkg.Kind == domain.CircuitKindOrderFill {
		if ticket.FillRef != "0" {
			return fmt.Errorf("ORDER_FILL ticket must use fillRef 0")
		}
		return nil
	}
	fillRef, err := strconv.ParseInt(ticket.FillRef, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid DCA fillRef")
	}
	if fillRef != fillCtx.BlockTimestamp {
		return fmt.Errorf("DCA ticket fillRef does not match evaluated block timestamp")
	}
	return nil
}

func (m *MonitorService) resetToPending(ctx context.Context, s *domain.PendingIntent) {
	reset, err := m.repo.ResetEvaluation(ctx, s.CommitmentHash)
	if err != nil {
		log.Printf("[Monitor] reset %s... to PENDING: %v", shortHash(s.CommitmentHash), err)
		return
	}
	if reset {
		s.Status = domain.IntentPending
		return
	}
	log.Printf("[Monitor] skip reset for %s... because status changed during evaluation", shortHash(s.CommitmentHash))
	m.StopMonitoring(s.CommitmentHash)
}

func (m *MonitorService) markEvaluationFailed(ctx context.Context, commitmentHash, reason string) {
	marked, err := m.repo.MarkFailed(ctx, commitmentHash, reason)
	if err != nil {
		log.Printf("[Monitor] mark %s... FAILED: %v", shortHash(commitmentHash), err)
		return
	}
	if !marked {
		log.Printf("[Monitor] skip FAILED for %s... because status changed during evaluation", shortHash(commitmentHash))
	}
}

func isPermanentEnclaveImportError(err error) bool {
	var httpErr *EnclaveHTTPError
	if errors.As(err, &httpErr) {
		return httpErr.StatusCode >= 400 && httpErr.StatusCode < 500
	}
	return false
}

func (m *MonitorService) pruneEnclave(ctx context.Context, commitmentHash string) error {
	if m.enclave == nil {
		return nil
	}
	pruneCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return m.enclave.Prune(pruneCtx, commitmentHash)
}

func (m *MonitorService) latestBlockContext(ctx context.Context, fallbackTimestamp int64) (string, int64, error) {
	if m.ethClient == nil {
		return "", fallbackTimestamp, nil
	}
	header, err := m.ethClient.HeaderByNumber(ctx, nil)
	if err != nil {
		return "", 0, fmt.Errorf("latest block header: %w", err)
	}
	return header.Number.String(), int64(header.Time), nil
}

func (m *MonitorService) isCommitmentPendingOnChain(ctx context.Context, commitmentHash string) (bool, error) {
	if !m.hasRegistry {
		return false, fmt.Errorf("registry unavailable")
	}
	return m.isCommitmentPendingOnChainAt(ctx, m.registryAddr, commitmentHash)
}

func (m *MonitorService) isCommitmentPendingOnChainAt(ctx context.Context, registryAddr common.Address, commitmentHash string) (bool, error) {
	packed, err := m.regABI.Pack("getCommitmentStatus", common.HexToHash(commitmentHash))
	if err != nil {
		return false, fmt.Errorf("pack getCommitmentStatus: %w", err)
	}
	result, err := m.ethClient.CallContract(ctx, ethereum.CallMsg{To: &registryAddr, Data: packed}, nil)
	if err != nil {
		return false, fmt.Errorf("call getCommitmentStatus: %w", err)
	}
	out, err := m.regABI.Unpack("getCommitmentStatus", result)
	if err != nil {
		return false, fmt.Errorf("unpack getCommitmentStatus: %w", err)
	}
	status, ok := out[0].(uint8)
	if !ok {
		return false, fmt.Errorf("unexpected getCommitmentStatus return type")
	}
	return status == commitmentStatusPending, nil
}

func (m *MonitorService) ValidateExecutionTicketClaim(ctx context.Context, executor string, ticket domain.ExecutionTicket) (TicketClaimCheck, error) {
	if m.ethClient == nil {
		return TicketClaimCheck{}, fmt.Errorf("ethereum client unavailable")
	}
	if !common.IsHexAddress(executor) {
		return TicketClaimCheck{}, fmt.Errorf("executor must be an EVM address")
	}
	if !common.IsHexAddress(ticket.Registry) {
		return TicketClaimCheck{}, fmt.Errorf("ticket registry must be an EVM address")
	}

	fillRef, err := strconv.ParseUint(ticket.FillRef, 10, 64)
	if err != nil {
		return TicketClaimCheck{}, fmt.Errorf("invalid ticket fillRef: %w", err)
	}
	if !isHexBytes32(ticket.ProverID) {
		return TicketClaimCheck{}, fmt.Errorf("ticket missing proverId")
	}
	if !strings.EqualFold(ticket.ProverReceipt.ProverID, ticket.ProverID) ||
		ticket.ProverReceipt.TicketExpiresAt < 0 ||
		ticket.ProverReceipt.TicketExpiresAt != ticket.TicketExpiresAt ||
		!isHexData(ticket.ProverReceipt.Signature) {
		return TicketClaimCheck{}, fmt.Errorf("ticket missing proverReceipt")
	}
	receipt := proverReceiptCall{
		ProverId:        common.HexToHash(ticket.ProverReceipt.ProverID),
		TicketExpiresAt: uint64(ticket.ProverReceipt.TicketExpiresAt),
		Signature:       common.FromHex(ticket.ProverReceipt.Signature),
	}

	registryAddr := common.HexToAddress(ticket.Registry)
	data, err := m.regABI.Pack(
		"executeCommitment",
		common.HexToHash(ticket.CommitmentHash),
		common.HexToHash(ticket.Nullifier),
		common.FromHex(ticket.Proof),
		fillRef,
		receipt,
	)
	if err != nil {
		return TicketClaimCheck{}, fmt.Errorf("pack executeCommitment: %w", err)
	}

	from := common.HexToAddress(executor)
	_, callErr := m.ethClient.CallContract(ctx, ethereum.CallMsg{
		From: from,
		To:   &registryAddr,
		Gas:  claimSimulationGasLimit,
		Data: data,
	}, nil)
	if callErr == nil {
		return TicketClaimCheck{Executable: true, CommitmentPending: true}, nil
	}

	pending, statusErr := m.isCommitmentPendingOnChainAt(ctx, registryAddr, ticket.CommitmentHash)
	if statusErr != nil {
		return TicketClaimCheck{}, fmt.Errorf("simulate executeCommitment: %w; status check: %w", callErr, statusErr)
	}
	return TicketClaimCheck{
		Executable:        false,
		CommitmentPending: pending,
		Reason:            callErr.Error(),
	}, nil
}

func shortHash(hash string) string {
	if len(hash) <= 10 {
		return hash
	}
	return hash[:10]
}

func isHexBytes32(value string) bool {
	return len(value) == 66 && isHexData(value)
}

func isHexData(value string) bool {
	if len(value) < 2 || !strings.HasPrefix(value, "0x") || len(value)%2 != 0 {
		return false
	}
	for _, r := range value[2:] {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F') {
			continue
		}
		return false
	}
	return true
}

func (m *MonitorService) fetchPairPrice(ctx context.Context, tokenIn, tokenOut string) (*big.Int, error) {
	addrIn := common.HexToAddress(tokenIn)
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

	priceU, err := derivePairPrice(answerIn, dIn, answerOut, dOut)
	if err != nil {
		return nil, err
	}
	return priceU, nil
}

func derivePairPrice(answerIn *big.Int, dIn uint8, answerOut *big.Int, dOut uint8) (*big.Int, error) {
	if answerIn == nil || answerIn.Sign() <= 0 {
		return nil, fmt.Errorf("non-positive tokenIn oracle answer")
	}
	if answerOut == nil || answerOut.Sign() <= 0 {
		return nil, fmt.Errorf("non-positive tokenOut oracle answer")
	}
	if dIn > 18 || dOut > 18 {
		return nil, fmt.Errorf("oracle decimals above 18 are unsupported")
	}

	ten := big.NewInt(10)
	normIn := new(big.Int).Mul(answerIn, new(big.Int).Exp(ten, big.NewInt(int64(18-dIn)), nil))
	normOut := new(big.Int).Mul(answerOut, new(big.Int).Exp(ten, big.NewInt(int64(18-dOut)), nil))
	priceU := new(big.Int).Div(
		new(big.Int).Mul(normIn, new(big.Int).Exp(ten, big.NewInt(int64(dOut)), nil)),
		normOut,
	)

	if priceU.Sign() <= 0 {
		return nil, fmt.Errorf("derived pair price is zero")
	}
	if priceU.BitLen() > 64 {
		return nil, fmt.Errorf("derived pair price overflows uint64")
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
