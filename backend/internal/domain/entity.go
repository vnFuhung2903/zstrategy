package domain

import "time"

type StrategyStatus string

const (
	StrategyPending   StrategyStatus = "PENDING"
	StrategyExecuting StrategyStatus = "EXECUTING"
	StrategyDone      StrategyStatus = "DONE"
)

type PendingStrategy struct {
	ID             uint           `gorm:"primaryKey;autoIncrement"`
	CommitmentHash string         `gorm:"uniqueIndex;size:66;not null"`
	ChainID        int64          `gorm:"not null"`
	Kind           CommitmentKind `gorm:"size:20;not null;default:'ORDER_FILL'"`
	TokenIn        string         `gorm:"size:42;not null"`
	TokenOut       string         `gorm:"size:42;not null"`
	Size           string         `gorm:"not null"`
	MinOut         string         `gorm:"not null"`
	Expiry         int64          `gorm:"not null"`
	LimitPrice     string         `gorm:"not null;default:'0'"`
	Direction      int            `gorm:"not null;default:0"`
	Nonce          string         `gorm:"size:66;not null"`
	Nullifier      string         `gorm:"size:66;not null"`
	ScheduledLo    *int64
	ScheduledHi    *int64
	Status         StrategyStatus `gorm:"size:20;not null;default:'PENDING'"`
	CreatedAt      time.Time      `gorm:"autoCreateTime"`
	UpdatedAt      time.Time      `gorm:"autoUpdateTime"`
}

type ExecutionStatus string
type CommitmentKind string

const (
	StatusRegistered ExecutionStatus = "registered"
	StatusExecuted   ExecutionStatus = "executed"
	StatusCancelled  ExecutionStatus = "cancelled"
	StatusExpired    ExecutionStatus = "expired"
)

const (
	KindOrderFill CommitmentKind = "ORDER_FILL"
	KindDCA       CommitmentKind = "DCA"
	// KindMarket is a backend-only orchestration flag: on-chain the commitment
	// is still kind=0 (ORDER_FILL) with a sentinel price that trivially fills.
	// The monitor goroutine fires the keeper trigger immediately rather than
	// polling Chainlink. Stored in pending_strategies for dashboard visibility;
	// translated to ORDER_FILL on the wire when forwarded to the keeper.
	KindMarket CommitmentKind = "MARKET"
)

// ExecutionRecord is an anonymized on-chain event record.
// No strategy parameters (price, size, direction) are ever stored.
type ExecutionRecord struct {
	ID             uint            `gorm:"primaryKey;autoIncrement"                                  json:"id"`
	CommitmentHash string          `gorm:"uniqueIndex;size:66;not null"                              json:"commitment_hash"`
	ChainID        int64           `gorm:"not null;index"                                            json:"chain_id"`
	Status         ExecutionStatus `gorm:"size:20;not null;index"                                    json:"status"`
	Kind           CommitmentKind  `gorm:"size:20;not null;default:'ORDER_FILL';index"               json:"kind"`
	TxHash         string          `gorm:"size:66"                                                   json:"tx_hash"`
	BlockNumber    uint64          `                                                                 json:"block_number"`
	GasUsed        uint64          `                                                                 json:"gas_used"`
	RegisteredAt   time.Time       `gorm:"not null"                                                  json:"registered_at"`
	ExecutedAt     *time.Time      `gorm:"index"                                                     json:"executed_at"`
	IndexedAt      time.Time       `gorm:"autoCreateTime"                                            json:"indexed_at"`
}

type KindBreakdown struct {
	TotalRegistered int64 `json:"total_registered"`
	TotalExecuted   int64 `json:"total_executed"`
	TotalCancelled  int64 `json:"total_cancelled"`
	TotalExpired    int64 `json:"total_expired"`
}

type Statistics struct {
	ChainID          int64                     `json:"chain_id"`
	TotalRegistered  int64                     `json:"total_registered"`
	TotalExecutions  int64                     `json:"total_executions"`
	TotalCancelled   int64                     `json:"total_cancelled"`
	TotalExpired     int64                     `json:"total_expired"`
	SuccessRate      float64                   `json:"success_rate"`
	AvgLatencyMs     float64                   `json:"avg_latency_ms"`
	AvgGasUsed       float64                   `json:"avg_gas_used"`
	ByKind           map[string]*KindBreakdown `json:"by_kind"`
}

type KeeperHealth struct {
	Online         bool      `json:"online"`
	MonitoredCount int       `json:"monitored_count"`
	ExecutedCount  int       `json:"executed_count"`
	FailedCount    int       `json:"failed_count"`
	LastSeenAt     time.Time `json:"last_seen_at"`
}
