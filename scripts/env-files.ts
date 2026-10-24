/** The project's env files, read without touching process.env (see ./env for the command-line scripts). */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export const ENV_FILES = [".env.local", ".env"];

/** Variables defined in the project's env files (earlier files win). */
export function readEnvFiles(dir = process.cwd()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_FILES) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
      if (value !== undefined) out[key] ??= value;
    }
  }
  return out;
}
