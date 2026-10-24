/**
 * Command-line scripts read .env.local then .env like `next dev` does; variables already set in the shell win.
 * Import this module first.
 */
import { readEnvFiles } from "./env-files";

for (const [key, value] of Object.entries(readEnvFiles())) process.env[key] ??= value;
