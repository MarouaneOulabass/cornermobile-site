export type Role = "admin" | "consultant" | "executive" | "business_owner";
export type ValidationStatus = "a_verifier" | "valide" | "corrige" | "rejete";

export interface User {
  id: string;
  email: string;
  full_name: string;
  is_platform_admin: boolean;
}

export interface Membership {
  organization_id: string;
  organization_name: string;
  role: Role;
  department_scope: string | null;
}

export interface Me {
  user: User;
  memberships: Membership[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  sector: string | null;
  city: string | null;
  employees: number | null;
  revenue_mad: number | null;
  description: string | null;
  retention_days: number;
}

export interface InterviewItem {
  id: string;
  question: string;
  interviewee: string | null;
  done: boolean;
  notes: string | null;
}

export interface Mission {
  id: string;
  organization_id: string;
  name: string;
  status: "draft" | "ingesting" | "analyzing" | "review" | "published";
  objectives: string[];
  scope: string[];
  interview_checklist: InterviewItem[];
  analysis_version: number;
  analyzed_at: string | null;
  published_at: string | null;
  parameters: Record<string, unknown>;
  created_at: string;
}

export interface MissionStats {
  documents: number;
  documents_indexed: number;
  documents_error: number;
  pain_points: number;
  pain_points_critical: number;
  opportunities: number;
  opportunities_priority: number;
  validated_share: number;
  annual_value_mad: number;
  alerts: string[];
  progress: number;
}

export interface PortfolioCard {
  organization: Organization;
  mission: Mission | null;
  stats: MissionStats;
  role: Role;
}

export interface SummaryOpportunity {
  id: string;
  title: string;
  priority_label: string | null;
  gross_annual_value: number | null;
  payback_months: number | null;
  effort: string;
  validation_status: ValidationStatus;
}

export interface SummaryPainPoint {
  id: string;
  title: string;
  criticality: string;
  confidence: number;
  is_hypothesis: boolean;
  validation_status: ValidationStatus;
}

export interface ExecSummary {
  organization: string;
  mission: string;
  headline: string;
  stats: MissionStats;
  top_opportunities: SummaryOpportunity[];
  top_pain_points: SummaryPainPoint[];
  decision: string | null;
  caveats: string[];
}

export interface DocumentItem {
  id: string;
  filename: string;
  path: string;
  file_type: string;
  size_bytes: number;
  sha256: string;
  version: number;
  is_current: boolean;
  previous_version_id: string | null;
  duplicate_of_id: string | null;
  status: "received" | "parsed" | "indexed" | "error" | "duplicate";
  error: string | null;
  category: string | null;
  category_confidence: number | null;
  classification_method: string | null;
  title: string | null;
  line_count: number;
  created_at: string;
}

export interface TableSummary {
  id: string;
  name: string;
  columns: string[];
  column_types: Record<string, string>;
  row_count: number;
  truncated: boolean;
}

export interface DocumentDetail extends DocumentItem {
  meta: Record<string, unknown>;
  tables: TableSummary[];
}

export interface TableRows {
  id: string;
  name: string;
  columns: string[];
  column_types: Record<string, string>;
  row_count: number;
  offset: number;
  rows: string[][];
  row_numbers: number[];
}

export interface DocumentLines {
  id: string;
  filename: string;
  start: number;
  end: number;
  total: number;
  lines: string[];
}

export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  total: number;
  done: number;
  message: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface UploadResult {
  job_id: string;
  received: number;
  queued: number;
  duplicates: number;
  errors: number;
  documents: DocumentItem[];
}

export interface SearchHit {
  document_id: string;
  filename: string;
  path: string;
  category: string | null;
  start_line: number;
  end_line: number;
  excerpt: string;
  score: number;
  lexical_rank: number | null;
  vector_rank: number | null;
}

export interface LibraryStats {
  total: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  by_type: Record<string, number>;
  tables: number;
  rows: number;
}

export interface Evidence {
  id: string;
  document_id: string | null;
  kind: "excerpt" | "rows" | "aggregate" | "document";
  locator: { lines?: [number, number]; table_id?: string; table?: string; rows?: number[]; row_count?: number; columns?: string[] };
  excerpt: string;
  summary: string;
  value: Record<string, unknown>;
  relevance: number;
  origin: "engine" | "user";
  detector: string | null;
  filename: string | null;
  path: string | null;
  category: string | null;
}

export interface Validation {
  id: string;
  target_type: string;
  target_id: string;
  status: ValidationStatus;
  comment: string | null;
  changes: Record<string, { before: unknown; after: unknown }>;
  user_name: string | null;
  created_at: string;
}

export interface Comment {
  id: string;
  target_type: string;
  target_id: string;
  kind: "comment" | "contestation";
  body: string;
  user_name: string | null;
  resolved: boolean;
  created_at: string;
}

export interface GraphNode {
  id: string;
  kind: string;
  key: string;
  label: string;
  properties: Record<string, unknown>;
  origin: "engine" | "user";
  x: number | null;
  y: number | null;
}

export interface GraphEdge {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  label: string | null;
  weight: number;
  properties: Record<string, unknown>;
  origin: "engine" | "user";
  evidence_count: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ProcessStep {
  id: string;
  ordinal: number;
  label: string;
  tool: string | null;
  is_manual: boolean;
  is_reentry: boolean;
  requires_validation: boolean;
  line: number | null;
}

export interface Process {
  id: string;
  name: string;
  description: string | null;
  owner_department: string | null;
  owner_defined: boolean;
  tools: string[];
  inputs: string[];
  outputs: string[];
  cycle_time_minutes: number | null;
  confidence: number;
  source_document_id: string | null;
  validation_status: ValidationStatus;
  edited_fields: string[];
  generated: Record<string, unknown>;
  steps: ProcessStep[];
  pain_points: number;
  pain_points_critical: number;
  evidence_count: number;
}
