-- Initial schema for zstrategy backend.
--
-- Two tables:
--   * execution_records — anonymized on-chain event log.
--   * pending_intents   — public intent metadata plus encrypted witness
--                         packages for the v2 enclave scheduler.

CREATE TABLE IF NOT EXISTS execution_records (
    id              BIGSERIAL    PRIMARY KEY,
    commitment_hash VARCHAR(66)  NOT NULL UNIQUE,
    chain_id        BIGINT       NOT NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'registered',
    kind            VARCHAR(20)  NOT NULL DEFAULT 'LIMIT',
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

CREATE TABLE IF NOT EXISTS pending_intents (
    id              BIGSERIAL    PRIMARY KEY,
    commitment_hash VARCHAR(66)  NOT NULL UNIQUE,
    chain_id        BIGINT       NOT NULL,
    registry        VARCHAR(42)  NOT NULL,
    kind            VARCHAR(20)  NOT NULL DEFAULT 'LIMIT',
    dca_group_lock_id VARCHAR(66) NOT NULL DEFAULT '',
    token_in        VARCHAR(42)  NOT NULL,
    token_out       VARCHAR(42)  NOT NULL,
    size            TEXT         NOT NULL,
    min_out         TEXT         NOT NULL,
    expiry          BIGINT       NOT NULL,
    witness_package JSONB        NOT NULL,
    ticket          JSONB,
    leased_by       VARCHAR(42)  NOT NULL DEFAULT '',
    ticket_expires_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    last_error      TEXT         NOT NULL DEFAULT '',
    status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pi_status         ON pending_intents (status);
CREATE INDEX IF NOT EXISTS idx_pi_chain_id       ON pending_intents (chain_id);
CREATE INDEX IF NOT EXISTS idx_pi_status_updated ON pending_intents (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_pi_ticket_expiry  ON pending_intents (status, ticket_expires_at);
CREATE INDEX IF NOT EXISTS idx_pi_lease_expiry   ON pending_intents (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_pi_dca_group_lock_status ON pending_intents (dca_group_lock_id, status);
