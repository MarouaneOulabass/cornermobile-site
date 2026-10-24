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
