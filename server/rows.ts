/** Row shapes returned by hand-written queries (snake_case, as stored). */

export interface UserRow {
  id: string;
  external_id: string;
  email: string;
  full_name: string;
  password_hash: string | null;
  is_platform_admin: boolean;
  is_active: boolean;
}

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  clerk_org_id: string | null;
  sector: string | null;
  city: string | null;
  employees: number | null;
  revenue_mad: number | null;
  description: string | null;
  retention_days: number;
  created_at: Date;
  updated_at: Date;
}

export interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
  department_scope: string | null;
}

export interface MissionRow {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  objectives: string[];
  scope: string[];
  interview_checklist: Record<string, unknown>[];
  analysis_version: number;
  analyzed_at: Date | null;
  published_at: Date | null;
  created_by_id: string | null;
  parameters: Record<string, unknown>;
  insights: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow {
  id: string;
  organization_id: string;
  mission_id: string | null;
  kind: string;
  status: string;
  progress: number;
  total: number;
  done: number;
  message: string | null;
  error: string | null;
  payload: Record<string, unknown>;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

export interface PainPointRow {
  id: string;
  organization_id: string;
  mission_id: string;
  code: string;
  title: string;
  description: string;
  type: string;
  department: string | null;
  scope: string | null;
  frequency: string | null;
  frequency_per_month: number | null;
  impact: string | null;
  impact_mad_per_year: number | null;
  confidence: number;
  criticality: string;
  severity: number;
  is_hypothesis: boolean;
  process_id: string | null;
  ordinal: number;
  validation_status: string;
  generated: Record<string, unknown>;
  edited_fields: string[];
}
