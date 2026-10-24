/** Integration-test helpers: a clean database per test. */
import { db, sql } from "@/server/db";

const TABLES = [
  "evidence_links", "evidence", "metrics", "opportunity_pain_points", "assumptions", "roi_models", "recommendations",
  "roadmap_items", "risks", "opportunities", "pain_points", "process_steps", "processes", "graph_edges", "graph_nodes",
  "document_chunks", "data_tables", "documents", "people", "data_sources", "tools", "departments", "validations",
  "comments", "exports", "jobs", "audit_missions", "scoring_models", "memberships", "audit_log", "users", "organizations",
];

export async function resetDb(): Promise<void> {
  await db.exec(sql`TRUNCATE ${sql.raw(TABLES.join(", "))} CASCADE`);
}
