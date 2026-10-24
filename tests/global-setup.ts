/**
 * Integration tests run against TEST_DATABASE_URL (a disposable PostgreSQL database, from the shell or
 * .env.local): the schema is recreated from db/ migrations once per run.
 */
import pg from "pg";
import { readEnvFiles } from "../scripts/env-files";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? readEnvFiles().TEST_DATABASE_URL ?? "postgresql://auditflow:auditflow@localhost:5432/auditflow_test";
  process.env.DATABASE_URL = url;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await client.end();
  const { migrate } = await import("../server/migrate");
  const { closePool } = await import("../server/db");
  await migrate();
  await closePool();
}
