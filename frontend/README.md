# zstrategy Frontend

Next.js 15 App Router frontend for creating private intents, registering
commitments, managing vault balances, and using the public executor UI.

## Prerequisites

- Node.js 20+
- npm 10+
- Browser wallet such as MetaMask
- Backend running at `NEXT_PUBLIC_BACKEND_URL`
- Simulated enclave reachable through the backend attestation route
- Deployed contracts on the configured chain

## Install Dependencies

```powershell
cd frontend
npm install
```

## Environment

File: `frontend/.env.local`.

```env
NEXT_PUBLIC_BACKEND_URL=http://localhost:8080
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_CHAIN_ID=421614
NEXT_PUBLIC_RPC_URL=https://YOUR_ARBITRUM_SEPOLIA_RPC
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=

NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS=0xYOUR_COMMITMENT_REGISTRY
NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS=0xYOUR_COLLATERAL_VAULT

NEXT_PUBLIC_WETH_ADDRESS=0xYOUR_WETH
NEXT_PUBLIC_USDC_ADDRESS=0xYOUR_USDC
NEXT_PUBLIC_USDT_ADDRESS=0xYOUR_USDT
NEXT_PUBLIC_WBTC_ADDRESS=0xYOUR_WBTC

NEXT_PUBLIC_ENCLAVE_ROOT_PUBLIC_KEY_PEM=
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | Yes | Base URL used by intent registration and enclave attestation helpers. |
| `NEXT_PUBLIC_API_URL` | Yes | Base URL used by stats, execution history, and executor ticket API helpers. Usually same as `NEXT_PUBLIC_BACKEND_URL`. |
| `NEXT_PUBLIC_CHAIN_ID` | Yes | Default API chain filter; Arbitrum Sepolia is `421614`. |
| `NEXT_PUBLIC_RPC_URL` | Yes | Wallet/client RPC transport for wagmi reads and writes. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | No | Enables WalletConnect. Injected wallets still work when empty. |
| `NEXT_PUBLIC_COMMITMENT_REGISTRY_ADDRESS` | Yes | Registry used for registration, execution, oracle feed lookup, and executor submission. |
| `NEXT_PUBLIC_COLLATERAL_VAULT_ADDRESS` | Yes | Vault used for ERC-20 deposits and balances. |
| `NEXT_PUBLIC_WETH_ADDRESS`, `NEXT_PUBLIC_USDC_ADDRESS`, `NEXT_PUBLIC_USDT_ADDRESS`, `NEXT_PUBLIC_WBTC_ADDRESS` | Yes for demo pairs | Token addresses shown in the UI. Defaults exist for Arbitrum Sepolia demo tokens. |
| `NEXT_PUBLIC_ENCLAVE_ROOT_PUBLIC_KEY_PEM` | Optional | Pins the simulated enclave root public key. Use escaped newlines if set. |

Do not put private keys, mnemonics, or API secrets in `NEXT_PUBLIC_*` values.
Every `NEXT_PUBLIC_*` value is bundled into browser JavaScript.

## Run In Development

```powershell
cd frontend
npm run dev
```

Open `http://localhost:3000`.

## Build

```powershell
cd frontend
npm run build
```

`next/font` fetches Google font assets during build. In a restricted network
environment, the build can fail until network access is allowed or fonts are
made local.

## Test And Lint

```powershell
cd frontend
npm run lint
npm run test:dca
```

## DCA Privacy Notes

- Raw `dcaGroupId`, DCA windows, nonces, nullifiers, and `userSecret` stay in
  browser-local state or inside encrypted witness packages.
- The backend receives only an opaque `dcaGroupLockId` for scheduler locking.
- Public executor APIs do not request or render witness packages or private DCA
  fields.

## Troubleshooting

- If the wallet shows zero contract addresses, check the contract address env
  values and restart `npm run dev`; Next.js reads env values at process start.
- If intent registration succeeds on-chain but backend post fails, verify
  `NEXT_PUBLIC_BACKEND_URL`, backend CORS/logs, and enclave attestation.
- If DCA registration fails with a backend AAD error, rebuild the frontend so
  package AAD uses `dcaGroupLockId`, not raw `dcaGroupId`.
- If WalletConnect is not available, set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`
  or use an injected wallet.
