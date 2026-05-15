import { startKeeper } from "./keeper";
import { startApiServer } from "./api/server";
import { loadOrCreateKeypairs } from "./threshold/keys";

async function main(): Promise<void> {
  // Load (or generate) the threshold keyset before anything else: API server
  // needs it to answer GET /api/keepers, and the submitter needs it for
  // share decryption at fill time.
  loadOrCreateKeypairs();

  startApiServer();
  await startKeeper();
}

main().catch(err => {
  console.error("[Fatal]", err);
  process.exit(1);
});
