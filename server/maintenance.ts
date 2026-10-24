/** Database maintenance used by the seed command and the tests. */
import { sql, type Db } from "./db";

// Every table holding mission data, users or audit trail (schema_migrations is kept).
export const DATA_TABLES = [
  "evidence_links", "evidence", "metrics", "opportunity_pain_points", "assumptions", "roi_models", "recommendations",
  "roadmap_items", "risks", "opportunities", "pain_points", "process_steps", "processes", "graph_edges", "graph_nodes",
  "document_chunks", "data_tables", "documents", "people", "data_sources", "tools", "departments", "validations",
  "comments", "exports", "jobs", "audit_missions", "scoring_models", "memberships", "audit_log", "users", "organizations",
];

export async function resetData(db: Db): Promise<void> {
  await db.exec(sql`TRUNCATE ${sql.raw(DATA_TABLES.join(", "))} CASCADE`);
}
