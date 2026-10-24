/**
 * npm run secrets — adds the secrets a local install needs to .env.local (created if missing).
 *
 * Existing values are never replaced. Works the same in PowerShell, cmd and bash (no shell redirection, whose
 * encoding differs between shells).
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const file = path.join(process.cwd(), ".env.local");
const current = (existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}) as Record<string, string | undefined>;
const wanted: Record<string, () => string> = {
  AUDITFLOW_SESSION_SECRET: () => randomBytes(48).toString("base64url"),
  CRON_SECRET: () => randomBytes(32).toString("hex"),
};
const added = Object.keys(wanted).filter((key) => !current[key]);
if (added.length) {
  const prefix = existsSync(file) && !readFileSync(file, "utf8").endsWith("\n") ? "\n" : "";
  appendFileSync(file, prefix + added.map((key) => `${key}=${wanted[key]()}\n`).join(""));
}
console.log(added.length ? `.env.local : ${added.join(", ")} ajouté(s)` : ".env.local contient déjà les secrets");
