/** Numbered SQL migrations from db/ (001_xxx.sql, 002_xxx.sql…), each applied once, in its own transaction. */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getPool, Db } from "./db";

export const MIGRATIONS_DIR = path.join(process.cwd(), "db");

export async function migrate(log: (line: string) => void = () => {}): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  const db = new Db(client);
  const applied: string[] = [];
  try {
    await db.script(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    // One migrator at a time (concurrent deploys or test workers).
    await db.script("SELECT pg_advisory_lock(727274)");
    const done = new Set(
      (await client.query("SELECT version FROM schema_migrations")).rows.map((r) => (r as { version: string }).version),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const version = file.slice(0, 3);
      if (done.has(version)) continue;
      const text = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await db.script(text);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
  } finally {
    await db.script("SELECT pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return applied;
}
