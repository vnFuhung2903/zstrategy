package domain

import "time"

type IntentStatus string

const (
	IntentPending     IntentStatus = "PENDING"
	IntentEvaluating  IntentStatus = "EVALUATING"
	IntentTicketReady IntentStatus = "TICKET_READY"
	IntentDone        IntentStatus = "DONE"
	IntentFailed      IntentStatus = "FAILED"
)

type PendingIntent struct {
	ID              uint       `gorm:"primaryKey;autoIncrement"`
	CommitmentHash  string     `gorm:"uniqueIndex;size:66;not null"`
	ChainID         int64      `gorm:"not null"`
	Registry        string     `gorm:"size:42;not null"`
	Kind            IntentKind `gorm:"size:20;not null;default:'LIMIT'"`
	DCAGroupLockID  string     `gorm:"size:66;index"`
	TokenIn         string     `gorm:"size:42;not null"`
	TokenOut        string     `gorm:"size:42;not null"`
	Size            string     `gorm:"not null"`
	MinOut          string     `gorm:"not null"`
	Expiry          int64      `gorm:"not null"`
	WitnessPackage  string     `gorm:"type:jsonb;not null"`
	Ticket          string     `gorm:"type:jsonb;default:'null'"`
	LeasedBy        string     `gorm:"size:42"`
	TicketExpiresAt *time.Time
	LeaseExpiresAt  *time.Time
	LastError       string       `gorm:"type:text"`
	Status          IntentStatus `gorm:"size:20;not null;default:'PENDING'"`
	CreatedAt       time.Time    `gorm:"autoCreateTime"`
	UpdatedAt       time.Time    `gorm:"autoUpdateTime"`
}

type ExecutionStatus string
type IntentKind string

const (
	StatusRegistered ExecutionStatus = "registered"
	StatusExecuted   ExecutionStatus = "executed"
	StatusCancelled  ExecutionStatus = "cancelled"
	StatusExpired    ExecutionStatus = "expired"
)

const (
	KindLimit  IntentKind = "LIMIT"
	KindDCA    IntentKind = "DCA"
	KindMarket IntentKind = "MARKET"
)

const OnChainKindOrderFill = "ORDER_FILL"

type IntentCircuitKind string

const (
	CircuitKindOrderFill IntentCircuitKind = "ORDER_FILL"
	CircuitKindDCA       IntentCircuitKind = "DCA"
)

type PublicIntentMetadata struct {
	Version        int               `json:"version"`
	ChainID        int64             `json:"chainId"`
	Registry       string            `json:"registry"`
	CommitmentHash string            `json:"commitmentHash"`
	Kind           IntentCircuitKind `json:"kind"`
	DCAGroupLockID string            `json:"dcaGroupLockId,omitempty"`
	TokenIn        string            `json:"tokenIn"`
	TokenOut       string            `json:"tokenOut"`
	Size           string            `json:"size"`
	MinOut         string            `json:"minOut"`
	Expiry         int64             `json:"expiry"`
}

type EncryptedWitnessPackage struct {
	Version          int                  `json:"version"`
	PackageHash      string               `json:"packageHash"`
	CommitmentHash   string               `json:"commitmentHash"`
	Kind             IntentCircuitKind    `json:"kind"`
	CommitteeID      string               `json:"committeeId"`
	EnclaveKeyID     string               `json:"enclaveKeyId"`
	EncryptionScheme string               `json:"encryptionScheme"`
	Ciphertext       string               `json:"ciphertext"`
	AAD              PublicIntentMetadata `json:"aad"`
}

type FillContext struct {
	ChainID        int64  `json:"chainId"`
	Registry       string `json:"registry"`
	BlockNumber    string `json:"blockNumber,omitempty"`
	BlockTimestamp int64  `json:"blockTimestamp"`
	OraclePrice    string `json:"oraclePrice,omitempty"`
}

type ExecutionTicket struct {
	Version         int               `json:"version"`
	ChainID         int64             `json:"chainId"`
	Registry        string            `json:"registry"`
	CommitmentHash  string            `json:"commitmentHash"`
	Kind            IntentCircuitKind `json:"kind"`
	Nullifier       string            `json:"nullifier"`
	FillRef         string            `json:"fillRef"`
	Proof           string            `json:"proof"`
	TicketExpiresAt int64             `json:"ticketExpiresAt"`
	Executor        string            `json:"executor,omitempty"`
	PackageHash     string            `json:"packageHash"`
	ProverID        string            `json:"proverId"`
	ProverReceipt   ProverReceipt     `json:"proverReceipt"`
}

type ProverReceipt struct {
	ProverID        string `json:"proverId"`
	TicketExpiresAt int64  `json:"ticketExpiresAt"`
	Signature       string `json:"signature"`
}

// ExecutionRecord is an anonymized on-chain event record.
// No plaintext intent witness fields are stored in execution records.
type ExecutionRecord struct {
	ID             uint            `gorm:"primaryKey;autoIncrement"                                  json:"id"`
	CommitmentHash string          `gorm:"uniqueIndex;size:66;not null"                              json:"commitment_hash"`
	ChainID        int64           `gorm:"not null;index"                                            json:"chain_id"`
	Status         ExecutionStatus `gorm:"size:20;not null;index"                                    json:"status"`
	Kind           IntentKind      `gorm:"size:20;not null;default:'LIMIT';index"                    json:"kind"`
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
	ChainID         int64                     `json:"chain_id"`
	TotalRegistered int64                     `json:"total_registered"`
	TotalExecutions int64                     `json:"total_executions"`
	TotalCancelled  int64                     `json:"total_cancelled"`
	TotalExpired    int64                     `json:"total_expired"`
	SuccessRate     float64                   `json:"success_rate"`
	AvgLatencyMs    float64                   `json:"avg_latency_ms"`
	AvgGasUsed      float64                   `json:"avg_gas_used"`
	ByKind          map[string]*KindBreakdown `json:"by_kind"`
}

type ExecutionFilters struct {
	Query  string
	Status ExecutionStatus
	Kind   IntentKind
}
