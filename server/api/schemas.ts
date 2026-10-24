/**
 * Response shapes (field lists in the order of the reference API's schemas) and request bodies.
 *
 * Serializers pick the public fields of a row, so internal columns (storage keys, password hashes, Clerk ids) never
 * leave the server by accident.
 */
import { z } from "zod";
import { DOCUMENT_CATEGORIES, GraphNodeKind, GraphRelation, VALIDATION_STATUSES } from "../domain/enums";

type Row = Record<string, unknown>;

export function pick(row: object, keys: readonly string[]): Row {
  const source = row as Row;
  return Object.fromEntries(keys.map((k) => [k, source[k] ?? null]));
}

export const USER_OUT = ["id", "email", "full_name", "is_platform_admin"] as const;
export const ORGANIZATION_OUT = ["id", "name", "slug", "sector", "city", "employees", "revenue_mad", "description", "retention_days"] as const;
export const MISSION_OUT = [
  "id", "organization_id", "name", "status", "objectives", "scope", "interview_checklist", "analysis_version", "analyzed_at", "published_at",
  "parameters", "created_at",
] as const;
export const DOCUMENT_OUT = [
  "id", "filename", "path", "file_type", "size_bytes", "sha256", "version", "is_current", "previous_version_id", "duplicate_of_id", "status", "error",
  "category", "category_confidence", "classification_method", "title", "line_count", "created_at",
] as const;
export const TABLE_SUMMARY = ["id", "name", "columns", "column_types", "row_count", "truncated"] as const;
export const JOB_OUT = ["id", "kind", "status", "progress", "total", "done", "message", "error", "created_at", "started_at", "finished_at"] as const;
export const EVIDENCE_OUT = ["id", "document_id", "kind", "locator", "excerpt", "summary", "value", "relevance", "origin", "detector"] as const;
export const EVIDENCE_WITH_DOC = [...EVIDENCE_OUT, "filename", "path", "category"] as const;
export const VALIDATION_OUT = ["id", "target_type", "target_id", "status", "comment", "changes", "user_name", "created_at"] as const;
export const COMMENT_OUT = ["id", "target_type", "target_id", "kind", "body", "user_name", "resolved", "created_at"] as const;
export const GRAPH_NODE_OUT = ["id", "kind", "key", "label", "properties", "origin", "x", "y"] as const;
export const GRAPH_EDGE_OUT = ["id", "source_id", "target_id", "relation", "label", "weight", "properties", "origin", "evidence_count"] as const;
export const PROCESS_STEP_OUT = ["id", "ordinal", "label", "tool", "is_manual", "is_reentry", "requires_validation", "line"] as const;
export const PROCESS_OUT = [
  "id", "name", "description", "owner_department", "owner_defined", "tools", "inputs", "outputs", "cycle_time_minutes", "confidence", "source_document_id",
  "validation_status", "edited_fields", "generated", "steps", "pain_points", "pain_points_critical", "evidence_count",
] as const;
export const METRIC_OUT = ["id", "key", "label", "value", "unit", "nature", "formula", "inputs", "evidence_count"] as const;
export const RISK_OUT = ["id", "title", "description", "kind", "likelihood", "severity", "exposure_mad_per_year", "pain_point_id", "validation_status"] as const;
export const PAIN_POINT_OUT = [
  "id", "code", "title", "description", "type", "department", "scope", "frequency", "frequency_per_month", "impact", "impact_mad_per_year", "confidence",
  "criticality", "severity", "is_hypothesis", "process_id", "process_name", "validation_status", "validated_at", "edited_fields", "generated",
  "evidence_count", "sources", "metrics", "risk", "opportunity_ids",
] as const;
export const ASSUMPTION_OUT = [
  "id", "key", "label", "value", "default_value", "unit", "nature", "source", "group", "confidence", "min_value", "max_value", "metric_id",
  "validation_status", "edited_fields", "validated_at", "evidence_count",
] as const;
export const PAIN_POINT_REF = ["id", "title", "criticality", "confidence", "is_hypothesis", "validation_status"] as const;
export const OPPORTUNITY_OUT = [
  "id", "code", "title", "summary", "category", "category_rationale", "department", "effort", "target_delivery", "scores", "priority_score", "priority_rank",
  "priority_label", "confidence", "validation_status", "validated_at", "edited_fields", "generated", "roi", "pain_points", "evidence_count",
] as const;
export const OPPORTUNITY_DETAIL = [...OPPORTUNITY_OUT, "architecture", "pilot_plan", "kpis", "assumptions", "lines", "weights", "penalties"] as const;
export const ROADMAP_ITEM_OUT = [
  "id", "opportunity_id", "title", "description", "phase", "kind", "start_week", "duration_weeks", "owner", "depends_on", "ordinal", "validation_status",
  "edited_fields", "generated", "value", "priority_label", "category",
] as const;
export const RECOMMENDATION_OUT = ["id", "title", "text", "ordinal", "opportunity_id", "validation_status", "edited_fields", "generated"] as const;
export const EXPORT_OUT = ["id", "format", "size_bytes", "sha256", "analysis_version", "published", "created_at"] as const;

// --- request bodies ---------------------------------------------------------------------------------------------

const optionalText = z.string().nullable().optional();
const nonNegativeInt = z.number().int().min(0);

export const LoginIn = z.object({ email: z.email(), password: z.string().min(1).max(200) });

export const OrganizationIn = z.object({
  name: z.string().min(2).max(200),
  sector: optionalText,
  city: optionalText,
  employees: nonNegativeInt.nullable().optional(),
  revenue_mad: nonNegativeInt.nullable().optional(),
  description: optionalText,
});

export const OrganizationPatch = z.object({
  name: z.string().min(2).max(200).nullable().optional(),
  sector: optionalText,
  city: optionalText,
  employees: nonNegativeInt.nullable().optional(),
  revenue_mad: nonNegativeInt.nullable().optional(),
  description: optionalText,
  retention_days: z.number().int().min(1).max(3650).nullable().optional(),
});

const InterviewItem = z.object({
  id: z.string(),
  question: z.string(),
  interviewee: z.string().nullable().default(null),
  done: z.boolean().default(false),
  notes: z.string().nullable().default(null),
});

export const MissionIn = z.object({
  name: z.string().min(2).max(200),
  objectives: z.array(z.string()).default([]),
  scope: z.array(z.string()).default([]),
  interview_checklist: z.array(InterviewItem).nullable().optional(),
});

export const MissionPatch = z.object({
  name: z.string().min(2).max(200).nullable().optional(),
  objectives: z.array(z.string()).nullable().optional(),
  scope: z.array(z.string()).nullable().optional(),
  interview_checklist: z.array(InterviewItem).nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const BenchmarksIn = z.object({ overrides: z.record(z.string(), z.number().nullable()) });

export const DocumentPatch = z.object({ category: z.enum(DOCUMENT_CATEGORIES) });

export const EvidenceIn = z.object({
  target_type: z.string(),
  target_id: z.uuid(),
  document_id: z.uuid(),
  summary: z.string().min(3).max(2000),
  lines: z.tuple([z.number().int(), z.number().int()]).nullable().optional(),
  table_id: z.uuid().nullable().optional(),
  rows: z.array(z.number().int()).nullable().optional(),
});

export const ReviewIn = z.object({
  status: z.enum(VALIDATION_STATUSES).nullable().optional(),
  comment: z.string().max(4000).nullable().optional(),
  changes: z.record(z.string(), z.unknown()).default({}),
});

export const CommentIn = z.object({
  target_type: z.string(),
  target_id: z.uuid(),
  body: z.string().min(1).max(4000),
  kind: z.enum(["comment", "contestation"]).default("comment"),
});

export const GraphNodeIn = z.object({
  kind: z.enum(Object.values(GraphNodeKind) as [string, ...string[]]),
  label: z.string().min(1).max(200),
  note: optionalText,
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
});

export const GraphNodePatch = z.object({
  label: z.string().min(1).max(200).nullable().optional(),
  note: optionalText,
  x: z.number().nullable().optional(),
  y: z.number().nullable().optional(),
  hidden: z.boolean().nullable().optional(),
});

const relation = z.enum(Object.values(GraphRelation) as [string, ...string[]]);

export const GraphEdgeIn = z.object({ source_id: z.uuid(), target_id: z.uuid(), relation, label: z.string().max(200).nullable().optional() });

export const GraphEdgePatch = z.object({ label: z.string().max(200).nullable().optional(), relation: relation.nullable().optional(), hidden: z.boolean().nullable().optional() });

export const SimulateIn = z.object({ overrides: z.record(z.string(), z.number()).default({}) });

export const ScoringModelIO = z.object({ weights: z.record(z.string(), z.number()), penalties: z.record(z.string(), z.number()) });

export const RoadmapItemIn = z.object({
  title: z.string().min(2).max(300),
  description: z.string().default(""),
  phase: z.string().default("j30"),
  start_week: z.number().int().min(0).max(104).nullable().optional(),
  duration_weeks: z.number().int().min(1).max(104).default(4),
  owner: optionalText,
  kind: z.enum(["quick_win", "pilote", "industrialisation", "projet", "socle"]).default("socle"),
  opportunity_id: z.uuid().nullable().optional(),
});

export const ExportIn = z.object({ format: z.enum(["pdf", "html"]).default("pdf") });

export const PublishIn = z.object({ acknowledge_unreviewed: z.boolean().default(false) });

/** Keys present in the request body (Pydantic's `exclude_unset`). */
export function setKeys(raw: unknown, parsed: Row): string[] {
  const sent = raw && typeof raw === "object" ? Object.keys(raw as Row) : [];
  return Object.keys(parsed).filter((k) => sent.includes(k));
}
