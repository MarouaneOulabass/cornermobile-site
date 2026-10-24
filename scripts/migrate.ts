/** npm run db:migrate — apply pending migrations from db/ to DATABASE_URL. */
import "./env";
import { closePool } from "../server/db";
import { migrate } from "../server/migrate";

migrate((line) => console.log(line))
  .then((applied) => console.log(applied.length ? `${applied.length} migration(s) applied` : "schema up to date"))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
