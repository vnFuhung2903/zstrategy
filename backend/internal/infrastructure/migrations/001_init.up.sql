-- Initial schema for zstrategy backend.
--
-- Two tables:
--   * execution_records  — anonymized on-chain event log (no strategy params).
--   * pending_strategies — private params + Shamir share routing for the
--                          MonitorService goroutines that trigger keeper fills.

CREATE TABLE IF NOT EXISTS execution_records (
    id              BIGSERIAL    PRIMARY KEY,
    commitment_hash VARCHAR(66)  NOT NULL UNIQUE,
    chain_id        BIGINT       NOT NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'registered',
    kind            VARCHAR(20)  NOT NULL DEFAULT 'ORDER_FILL',
    tx_hash         VARCHAR(66)  NOT NULL DEFAULT '',
    block_number    BIGINT       NOT NULL DEFAULT 0,
    gas_used        BIGINT       NOT NULL DEFAULT 0,
    registered_at   TIMESTAMPTZ  NOT NULL,
    executed_at     TIMESTAMPTZ,
    indexed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_er_chain_id    ON execution_records (chain_id);
CREATE INDEX IF NOT EXISTS idx_er_status      ON execution_records (status);
CREATE INDEX IF NOT EXISTS idx_er_kind        ON execution_records (kind);
CREATE INDEX IF NOT EXISTS idx_er_executed_at ON execution_records (executed_at);

CREATE TABLE IF NOT EXISTS pending_strategies (
    id              BIGSERIAL    PRIMARY KEY,
    commitment_hash VARCHAR(66)  NOT NULL UNIQUE,
    chain_id        BIGINT       NOT NULL,
    kind            VARCHAR(20)  NOT NULL DEFAULT 'ORDER_FILL',
    token_in        VARCHAR(42)  NOT NULL,
    token_out       VARCHAR(42)  NOT NULL,
    size            TEXT         NOT NULL,
    min_out         TEXT         NOT NULL,
    expiry          BIGINT       NOT NULL,
    limit_price     TEXT         NOT NULL DEFAULT '0',
    direction       SMALLINT     NOT NULL DEFAULT 0,
    nonce           VARCHAR(66)  NOT NULL,
    nullifier       VARCHAR(66)  NOT NULL,
    scheduled_lo    BIGINT,
    scheduled_hi    BIGINT,
    status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ps_status         ON pending_strategies (status);
CREATE INDEX IF NOT EXISTS idx_ps_chain_id       ON pending_strategies (chain_id);
CREATE INDEX IF NOT EXISTS idx_ps_status_updated ON pending_strategies (status, updated_at);
