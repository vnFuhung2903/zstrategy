# zstrategy circuits

Noir source for the ZK circuits that gate `CommitmentRegistry.executeCommitment`. Compiled with [Nargo](https://noir-lang.org/) and proven with Aztec's [Barretenberg](https://github.com/AztecProtocol/aztec-packages/tree/master/barretenberg) (UltraPlonk).

## Circuits

| Circuit             | Status   | Purpose                                                   |
|---------------------|----------|-----------------------------------------------------------|
| `order_fill`        | complete | Limit-order fill proof (also reused for stop-loss / TP)   |
| `dca` (planned)     | —        | Time-window proof for Phase 4                             |

### `order_fill`

Proves that:

1. `commitment_hash` binds to the on-chain registration fields (`token_in`, `token_out`, `size`, `min_out`, `expiry`) AND the private strategy params (`price`, `direction`, `nonce`, `user_secret`).
2. The fill condition is satisfied (`oracle_price <= price` for BUY, `>=` for SELL).
3. `nullifier == keccak256(user_secret || nonce)`.

Preimage layout (185 bytes, packed big-endian, byte-identical to `frontend/src/lib/commitment.ts` and Solidity `abi.encodePacked`):

```
token_in(20) || token_out(20) || size(32) || min_out(32)
  || expiry(8) || price(8) || direction(1) || nonce(32) || user_secret(32)
```

## Prerequisites

Install Nargo (the Noir compiler/test runner). On Linux/macOS:

```sh
curl -L noirup.dev | bash
noirup
```

On Windows, use the Nargo Windows installer or run inside WSL. Verify with `nargo --version`.

For Solidity verifier generation, install `bb` (Barretenberg CLI). See <https://github.com/AztecProtocol/aztec-packages>.

## Compile

```sh
cd circuits/order_fill
nargo compile
```

This produces `target/order_fill.json` (ACIR + circuit metadata) used by `bb.js` in the frontend.

## Test

```sh
cd circuits/order_fill
nargo test
```

The current suite (`src/main.nr`) covers BUY/SELL fill at and beyond the limit, malformed-address rejection, tampered commitment / nullifier rejection. Each test runs the full circuit against synthetic inputs.

## Generate Solidity verifier

After `nargo compile`, generate the on-chain verifier:

```sh
cd circuits/order_fill
bb write_vk -b ./target/order_fill.json -o ./target --oracle_hash keccak
bb write_solidity_verifier -k ./target/vk -o ../../contracts/contracts/core/ZKVerifier.sol
```

The `--oracle_hash keccak` flag produces an EVM-optimized verifier. Once generated, swap `MockZKVerifier` for `ZKVerifier` in the contract deployment script.
