# zstrategy Enclave

Simulated Nitro-style prover boundary for zstrategy v2. This package is the only
place that decrypts encrypted intent witness packages and generates OrderFill or
DCA proofs. The local process is not a hardware TEE; it exists to keep the same
interface that a later AWS Nitro Enclave adapter should expose.

## Local Demo

Install, build, and test:

```bash
cd enclave
npm install
npm run build
npm test
```

Run the local HTTP enclave service:

```bash
cd enclave
npm run dev
```

Default endpoint:

```text
http://localhost:3002
```

Backend configuration:

```bash
ENCLAVE_URL=http://localhost:3002
ENCLAVE_API_SECRET=
```

Available local endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Readiness check. |
| `GET` | `/metadata` | Local dev root public key, image digest, PCR-like measurements. |
| `POST` | `/attest` | Simulated attestation report bound to caller nonce. |
| `POST` | `/packages` | Import encrypted witness package. |
| `POST` | `/evaluate` | Evaluate one package with public fill context; returns `NOT_READY` or an execution ticket. |
| `DELETE` | `/packages/:hash` | Prune finalized/cancelled/expired package. |

The frontend does not send plaintext `price`, `direction`, `nonce`,
`userSecret`, `nullifier`, `scheduledLo`, or `scheduledHi` to the backend. It
gets an attestation through `POST /api/v1/enclave/attest`, verifies the simulated
report in-browser, encrypts the witness package to the enclave public key, and
then sends only public metadata plus `witnessPackage` to the v2 intent routes.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `ENCLAVE_PORT` | `3002` | Local HTTP port. |
| `ENCLAVE_API_SECRET` | empty | Optional bearer token for non-health routes. Match backend `ENCLAVE_API_SECRET`. |
| `ORDER_FILL_CIRCUIT_JSON` | `../circuits/order_fill/target/order_fill.json` | Compiled Noir circuit. |
| `DCA_CIRCUIT_JSON` | `../circuits/dca/target/dca.json` | Compiled Noir circuit. |
| `TICKET_TTL_SECONDS` | `60` | Ticket validity window. Short TTLs reduce stale-oracle tickets. |
| `PROVER_ID` | `simulated-nitro-local` | Included in execution tickets. |
| `ENCLAVE_PRIVATE_KEY_HEX` | generated at boot | X25519 private key for witness packages. For repeatable demos, set this explicitly. |
| `ENCLAVE_DEV_ROOT_PRIVATE_KEY_PEM` | generated at boot | Ed25519 simulated attestation root. Use escaped newlines in `.env`. |
| `ENCLAVE_DEV_ROOT_PUBLIC_KEY_PEM` | generated at boot | Public half of the simulated root. |

For a repeatable thesis demo, pin `ENCLAVE_PRIVATE_KEY_HEX` and the dev root PEM
pair. If they are generated at boot, witness packages encrypted before a restart
cannot be decrypted after restart.

## Production Nitro Shape

AWS Nitro Enclaves are isolated VMs created from an EC2 parent instance. AWS
documents that enclaves have no persistent storage, no interactive access, and
no external networking; the parent communicates locally, and attestation exposes
PCR measurements and optional fields such as a public key and nonce:

- [Nitro Enclaves overview](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html)
- [Nitro Enclaves concepts](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave-concepts.html)
- [Cryptographic attestation](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html)
- [Getting started](https://docs.aws.amazon.com/enclaves/latest/user/getting-started.html)
- [run-enclave command](https://docs.aws.amazon.com/enclaves/latest/user/cmd-nitro-run-enclave.html)

Production deployment should preserve this package's logical interface:

```ts
interface IntentProverEnclave {
  attest(req): Promise<AttestationReport>;
  importPackage(pkg): Promise<{ packageHash: string }>;
  evaluate(commitmentHash, ctx): Promise<"NOT_READY" | ExecutionTicket>;
  prune(commitmentHash): Promise<void>;
}
```

Nitro deployment outline:

1. Build the prover into a Docker image that starts `node dist/server.js` behind
   a vsock-compatible server instead of the local HTTP listener.
2. Convert the image to an EIF with `nitro-cli build-enclave`.
3. Record the EIF PCR measurements and pin them in frontend/backend config.
4. Run it from the EC2 parent with `nitro-cli run-enclave`, allocating enough
   memory for Barretenberg proof generation.
5. Run a parent-side proxy that translates backend HTTP calls to enclave vsock.
6. Replace simulated Ed25519 reports with real Nitro attestation documents and
   verify the AWS attestation root, PCRs, nonce, and enclave public key.
7. Use AWS KMS attestation policies for production key release instead of local
   `.env` private keys.

Security note: the local simulation demonstrates the boundary and message
shape. It does not protect memory from the host OS. The production claim only
applies after replacing the local report/key handling with real Nitro
attestation and a vsock transport.
