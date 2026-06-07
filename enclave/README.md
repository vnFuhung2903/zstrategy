# zstrategy Enclave

Simulated Nitro-style prover boundary for zstrategy v2. This package is the
only component that decrypts encrypted witness packages and generates
OrderFill/DCA proofs. The local process is not hardware isolation; it preserves
the interface shape for a later AWS Nitro adapter.

## Prerequisites

- Node.js 20+
- npm 10+
- Compiled Noir circuit artifacts:
  - `circuits/order_fill/target/order_fill.json`
  - `circuits/dca/target/dca.json`

## Install Dependencies

```powershell
cd enclave
npm install
```

## Environment

File: `enclave/.env`.

The current npm scripts read `process.env`; they do not automatically load
`.env`. Use a shell/runner that exports these values, or start Node with an
env-file capable runtime.

Generate fresh local-only demo keys with:

```powershell
cd enclave
npm run generate-demo-env
```

```env
ENCLAVE_PORT=3002
ENCLAVE_API_SECRET=
ORDER_FILL_CIRCUIT_JSON=../circuits/order_fill/target/order_fill.json
DCA_CIRCUIT_JSON=../circuits/dca/target/dca.json
TICKET_TTL_SECONDS=60
PROVER_ID=0xGENERATE_WITH_NPM_RUN_GENERATE_DEMO_ENV
PROVER_SIGNING_PRIVATE_KEY=0xGENERATE_WITH_NPM_RUN_GENERATE_DEMO_ENV
ENCLAVE_PRIVATE_KEY_HEX=0xGENERATE_WITH_NPM_RUN_GENERATE_DEMO_ENV
ENCLAVE_DEV_ROOT_PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----\nGENERATE_WITH_NPM_RUN_GENERATE_DEMO_ENV\n-----END PRIVATE KEY-----\n
ENCLAVE_DEV_ROOT_PUBLIC_KEY_PEM=-----BEGIN PUBLIC KEY-----\nGENERATE_WITH_NPM_RUN_GENERATE_DEMO_ENV\n-----END PUBLIC KEY-----\n
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ENCLAVE_PORT` | No | HTTP port; defaults to `3002`. |
| `ENCLAVE_API_SECRET` | No | Optional bearer token for non-health routes. Must match backend `ENCLAVE_API_SECRET` if set. |
| `ORDER_FILL_CIRCUIT_JSON` | Yes for real proof generation | Compiled ORDER_FILL circuit artifact path. |
| `DCA_CIRCUIT_JSON` | Yes for real DCA proof generation | Compiled DCA circuit artifact path. |
| `TICKET_TTL_SECONDS` | No | Execution ticket lifetime; defaults to `60`. |
| `PROVER_ID` | Yes for Phase E demo | 0x-prefixed bytes32 prover identity placed in execution tickets and receipts. Must match the registry `setProver` ID. |
| `PROVER_SIGNING_PRIVATE_KEY` | Yes for on-chain receipt verification | Secp256k1 key that signs Phase E prover receipts. Use a local demo key only. |
| `ENCLAVE_PRIVATE_KEY_HEX` | Recommended | X25519 private key for decrypting witness packages. If omitted, one is generated at boot and old packages cannot be decrypted after restart. |
| `ENCLAVE_DEV_ROOT_PRIVATE_KEY_PEM` | Recommended | Simulated attestation root private key. Use escaped newlines in `.env`. |
| `ENCLAVE_DEV_ROOT_PUBLIC_KEY_PEM` | Recommended | Simulated attestation root public key distributed to backend/frontend pinning. |

Do not commit real private keys or production secrets. The template values above
are placeholders only.

## Run In Development

```powershell
cd enclave
npm run dev
```

Default endpoint:

```text
http://localhost:3002
```

Available local endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Readiness check. |
| `GET` | `/metadata` | Dev root public key, image digest, PCR-like measurements. |
| `POST` | `/attest` | Simulated attestation report bound to caller nonce. |
| `POST` | `/packages` | Import encrypted witness package. |
| `POST` | `/evaluate` | Evaluate one package with public fill context; returns `NOT_READY` or an execution ticket. |
| `DELETE` | `/packages/:hash` | Prune finalized/cancelled/expired package. |

## Build

```powershell
cd enclave
npm run build
npm start
```

## Test

```powershell
cd enclave
npm test
```

## Privacy And DCA Notes

- Public AAD may include an opaque `dcaGroupLockId` for backend scheduling.
- Raw `dcaGroupId`, DCA windows, nonces, nullifiers, and `userSecret` are inside
  the encrypted witness and are decrypted only by this package.
- The enclave rejects overlapping same-group DCA windows before proof
  generation and keeps an in-enclave same-group proof lock.

## Troubleshooting

- If the backend cannot import packages after an enclave restart, pin
  `ENCLAVE_PRIVATE_KEY_HEX`; generated boot keys cannot decrypt old packages.
- If frontend attestation verification fails, make sure frontend
  `NEXT_PUBLIC_ENCLAVE_ROOT_PUBLIC_KEY_PEM` matches this enclave root public
  key and that escaped newlines are preserved.
- If proof generation fails because circuit artifacts are missing, rebuild the
  Noir artifacts and verify the `ORDER_FILL_CIRCUIT_JSON` and `DCA_CIRCUIT_JSON`
  paths from the `enclave/` working directory.
- If the backend returns 401 from enclave calls, set the same
  `ENCLAVE_API_SECRET` in backend and enclave environments.
