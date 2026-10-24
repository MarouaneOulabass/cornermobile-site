/** Server configuration, validated once. Every secret comes from the environment, never from code. */
import path from "node:path";
import { z } from "zod";

const flag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const schema = z.object({
  DATABASE_URL: z.string().default("postgresql://auditflow:auditflow@localhost:5432/auditflow"),
  // Authentication: Clerk in every deployed environment; local demo accounts only off-Vercel, on request.
  CLERK_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  AUDITFLOW_DEV_AUTH: flag,
  AUDITFLOW_SESSION_SECRET: z.string().optional(),
  AUDITFLOW_DEMO_PASSWORD: z.string().optional(),
  // Files: Vercel Blob when a token is present, otherwise the local disk.
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  AUDITFLOW_STORAGE_DIR: z.string().default(path.join(process.cwd(), "var", "storage")),
  // AI (classification of ambiguous documents only; never used for figures).
  AUDITFLOW_LLM_PROVIDER: z.enum(["none", "gateway"]).default("none"),
  AUDITFLOW_LLM_MODEL: z.string().default("anthropic/claude-opus-5-5"),
  AUDITFLOW_LLM_REDACT_PII: z
    .string()
    .optional()
    .transform((v) => v !== "0" && v !== "false"),
  AUDITFLOW_MAX_UPLOAD_MB: z.coerce.number().default(50),
  AUDITFLOW_MAX_FILES_PER_UPLOAD: z.coerce.number().default(500),
  AUDITFLOW_DEMO_DATA_DIR: z.string().default(path.join(process.cwd(), "demo-data")),
  CRON_SECRET: z.string().optional(),
  VERCEL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

/** Tests change the environment between files. */
export function resetEnv(): void {
  cached = null;
}

export function clerkEnabled(): boolean {
  return Boolean(env().CLERK_SECRET_KEY && env().NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

/**
 * Local demo accounts (email + password, signed cookie) exist for development, tests and offline demos only:
 * never when Clerk is configured and never on Vercel, whatever the flag says.
 */
export function devAuthEnabled(): boolean {
  const e = env();
  return e.AUDITFLOW_DEV_AUTH && !clerkEnabled() && e.VERCEL !== "1";
}
