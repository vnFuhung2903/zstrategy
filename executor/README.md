# zstrategy public executor

This package is the Phase D local/demo executor. A public executor runs it to
claim one backend-ready execution ticket from the Go backend and submit the
existing registry transaction:
`CommitmentRegistry.executeCommitment(commitmentHash, nullifier, proof, fillRef)`.

The backend does not import or call this package. It only exposes public ticket
endpoints. The executor wallet does not receive plaintext witness data,
witness packages, limit prices, directions, nonces, `user_secret`, or DCA
schedule bounds.

## Requirements

- Node.js 20+
- A funded executor wallet for the target chain
- A backend instance exposing `/api/v1/executor/tickets/claim`
- An RPC URL for the same chain as the ticket queue

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `BACKEND_URL` | No | Go backend URL. Defaults to `http://localhost:8080`. |
| `RPC_URL` | Yes | JSON-RPC URL for the target chain. |
| `EXECUTOR_PRIVATE_KEY` | Yes | Private key for the executor wallet. |
| `PRIVATE_KEY` | No | Fallback if `EXECUTOR_PRIVATE_KEY` is not set. |
| `CHAIN_ID` | No | Optional guard. If set, it must match the RPC chain ID. |

## Run locally

```powershell
cd executor
npm install
$env:BACKEND_URL = "http://localhost:8080"
$env:RPC_URL = "https://..."
$env:EXECUTOR_PRIVATE_KEY = "0x..."
npm run execute
```

The script claims one backend-ready ticket for the RPC chain, sending its
executor address so the backend can record a short lease and simulate
`executeCommitment` with `eth_call`. It validates the ticket envelope, estimates
gas, and submits the registry call. If no ticket is ready, it exits without
sending a transaction.

## Safety checks

The executor validates:

- required response and ticket fields;
- ticket chain ID matches the RPC chain;
- ticket registry and commitment hash match the response envelope;
- `ORDER_FILL` tickets use `fillRef = "0"`;
- every `fillRef` is a uint64 decimal string;
- ticket expiry has not passed;
- optional executor binding, if present, matches the local wallet.

## Limitations

- Backend leases coordinate honest executors but are not cryptographic
  executor binding. A copied transaction can still race in the mempool until a
  contract-level ticket/receipt path is added.
- The public list endpoint is eventually consistent with chain events. The
  claim endpoint performs fresh transaction simulation before returning a
  ticket, but the real transaction can still race the next block or a competing
  executor.
- Failed gas estimation, failed submission, reverted transactions, or provider
  timeouts do not mutate backend ticket state. The ticket remains retryable
  until expiry or until a terminal chain event is indexed.
- `ORDER_FILL` tickets do not carry an oracle price. The registry reads
  Chainlink at execution time; claim simulation catches stale proofs at claim
  time and the backend resets those tickets for re-evaluation.
- The Next.js frontend now includes a wired `/executor` route based on the
  `../ui/executor/` design. This CLI remains useful for local demos and
  headless executor runs.
