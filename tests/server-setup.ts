/** Server test environment: local demo accounts, inline jobs, files in a temporary folder, no Clerk, no LLM. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AUDITFLOW_DEV_AUTH = "1";
process.env.AUDITFLOW_SESSION_SECRET ??= "test-session-secret-not-for-production-0123456789";
process.env.AUDITFLOW_DEMO_PASSWORD ??= "demo-test";
process.env.AUDITFLOW_JOBS = "inline";
process.env.AUDITFLOW_LLM_PROVIDER = "none";
process.env.AUDITFLOW_STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "auditflow-test-"));
delete process.env.CLERK_SECRET_KEY;
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.VERCEL;
