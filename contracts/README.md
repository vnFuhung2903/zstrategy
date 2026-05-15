# zstrategy contracts

Solidity 0.8.24 contracts deployed via Hardhat. Trust root of the system.

## Contracts

```
contracts/
  core/
    CommitmentRegistry.sol   # register / execute / cancel / sweep, Chainlink read at fill time
    CollateralVault.sol      # ERC-20 collateral, registry-only mutators
  adapters/
    UniswapV3Adapter.sol     # exactInputSingle wrapper, lazy forceApprove, configurable swap-deadline buffer
    MockDEXAdapter.sol       # configurable swap result for tests / testnets without UniV3
  interfaces/
    IVerifier.sol
    IDEXAdapter.sol
    IPriceFeed.sol           # Chainlink-compatible AggregatorV3Interface subset
  test/
    MockZKVerifier.sol       # accepts any proof; `setShouldPass(false)` to test rejection
    MockChainlinkAggregator.sol
    MockERC20.sol
```

## Prerequisites

- Node.js 20+
- npm

## Install

```sh
cd contracts
npm install
```

## Compile

```sh
npx hardhat compile
```

Generates artifacts under `artifacts/` and TypeChain types under `typechain-types/`.

## Test

```sh
npx hardhat test
```

The suite covers the full commitment lifecycle (register → execute → settle), cancellation, sweepExpired, the per-token volume circuit breaker, oracle staleness rejection, and storage-layout assertions.

Run a single test:

```sh
npx hardhat test --grep "CommitmentRegistry"
```

## Deploy

`scripts/deploy.ts` handles both local and testnet deployment. Mocks are deployed by default; override any component via env var to reuse an existing address (see header of `scripts/deploy.ts`).

```sh
# Local hardhat node
npx hardhat node                                       # in another terminal
npx hardhat run scripts/deploy.ts --network localhost

# Arbitrum Sepolia
ARBITRUM_SEPOLIA_RPC=... PRIVATE_KEY=... \
  npx hardhat run scripts/deploy.ts --network arbitrumSepolia
```

After deploy, the script writes addresses to `deployments/<network>.json` and prints the env-var snippets the frontend (`NEXT_PUBLIC_*`) and keeper (`*_ADDRESS`) need.

## Networks

Configured in `hardhat.config.ts`. Both testnets accept `PRIVATE_KEY` + their `*_RPC` env var.

| Name              | Use                              |
|-------------------|----------------------------------|
| `hardhat`         | In-process for tests             |
| `arbitrumSepolia` | Primary testnet target           |
