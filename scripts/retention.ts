/** npm run retention -- [--dry-run] : delete missions idle for longer than their organization's retention period. */
import { closePool } from "../server/db";
import { purge } from "../server/services/retention";

const dryRun = process.argv.includes("--dry-run");
purge({ dryRun })
  .then((removed) => console.log(`${removed.length} mission(s) ${dryRun ? "à supprimer" : "supprimée(s)"}`))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
