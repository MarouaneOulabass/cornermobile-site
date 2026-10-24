-- 001 — initial schema (ported from the Python/SQLAlchemy model).
-- Every tenant row carries organization_id; mission-scoped rows also carry mission_id.

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Tenancy -------------------------------------------------------------------------------------------------

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(200) NOT NULL,
  slug varchar(80) NOT NULL UNIQUE,
  clerk_org_id text UNIQUE,                       -- one Clerk organization per client
  sector varchar(200),
  city varchar(120),
  employees integer,
  revenue_mad bigint,
  description text,
  retention_days integer NOT NULL DEFAULT 365,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL UNIQUE,               -- Clerk user id, or "dev:<email>" for local accounts
  email varchar(254) NOT NULL UNIQUE,
  full_name varchar(200) NOT NULL,
  password_hash varchar(200),                     -- local development accounts only
  is_platform_admin boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role varchar(32) NOT NULL,                      -- admin | consultant | executive | business_owner
  department_scope varchar(120),                  -- business owners only see their department
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);
CREATE INDEX ix_memberships_organization_id ON memberships (organization_id);

CREATE TABLE scoring_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  weights jsonb NOT NULL DEFAULT '{}',
  penalties jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_scoring_models_organization_id ON scoring_models (organization_id);

-- Audit log: identifiers, counts and statuses only, never client content.
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action varchar(80) NOT NULL,
  entity_type varchar(40),
  entity_id varchar(64),
  details jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_log_organization_id ON audit_log (organization_id);
CREATE INDEX ix_audit_log_at ON audit_log (at);

-- Missions ------------------------------------------------------------------------------------------------

CREATE TABLE audit_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'draft',
  objectives jsonb NOT NULL DEFAULT '[]',
  scope jsonb NOT NULL DEFAULT '[]',
  interview_checklist jsonb NOT NULL DEFAULT '[]',
  analysis_version integer NOT NULL DEFAULT 0,
  analyzed_at timestamptz,
  published_at timestamptz,
  created_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  parameters jsonb NOT NULL DEFAULT '{}',
  insights jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_missions_organization_id ON audit_missions (organization_id);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  headcount integer NOT NULL DEFAULT 0,
  manager_external_id varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_departments_mission_id ON departments (mission_id);

CREATE TABLE tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  category varchar(40) NOT NULL DEFAULT 'autre',
  users_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tools_mission_id ON tools (mission_id);

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  external_id varchar(64),
  name varchar(200) NOT NULL,
  role varchar(120),
  seniority_years double precision,
  department_id uuid REFERENCES departments (id) ON DELETE SET NULL,
  primary_tool_id uuid REFERENCES tools (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_people_mission_id ON people (mission_id);

CREATE TABLE data_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  kind varchar(40) NOT NULL DEFAULT 'autre',
  tool_id uuid REFERENCES tools (id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_data_sources_mission_id ON data_sources (mission_id);

-- Sources -------------------------------------------------------------------------------------------------

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  filename varchar(255) NOT NULL,
  path varchar(1024) NOT NULL,                    -- relative path inside the imported folder
  file_type varchar(16) NOT NULL,
  mime_type varchar(120),
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256 varchar(64) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  previous_version_id uuid REFERENCES documents (id) ON DELETE SET NULL,
  duplicate_of_id uuid REFERENCES documents (id) ON DELETE SET NULL,
  storage_key varchar(512) NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  status varchar(16) NOT NULL DEFAULT 'received',
  error text,
  category varchar(32),
  category_confidence double precision,
  classification_method varchar(32),
  title varchar(300),
  meta jsonb NOT NULL DEFAULT '{}',
  text text,
  line_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_documents_mission_id ON documents (mission_id);
CREATE INDEX ix_documents_sha256 ON documents (sha256);

CREATE TABLE data_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  columns jsonb NOT NULL DEFAULT '[]',
  column_types jsonb NOT NULL DEFAULT '{}',
  rows jsonb NOT NULL DEFAULT '[]',
  row_count integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_data_tables_document_id ON data_tables (document_id);
CREATE INDEX ix_data_tables_mission_id ON data_tables (mission_id);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  text text NOT NULL,
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  embedding jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_document_chunks_mission_id ON document_chunks (mission_id);
CREATE INDEX ix_document_chunks_document_id ON document_chunks (document_id);

-- Analysis ------------------------------------------------------------------------------------------------

CREATE TABLE processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  name varchar(200) NOT NULL,
  description text,
  owner_department varchar(120),
  owner_defined boolean NOT NULL DEFAULT false,
  tools jsonb NOT NULL DEFAULT '[]',
  inputs jsonb NOT NULL DEFAULT '[]',
  outputs jsonb NOT NULL DEFAULT '[]',
  cycle_time_minutes double precision,
  confidence double precision NOT NULL DEFAULT 0.5,
  source_document_id uuid REFERENCES documents (id) ON DELETE SET NULL,
  validation_status varchar(16) NOT NULL DEFAULT 'a_verifier',
  validated_at timestamptz,
  validated_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  generated jsonb NOT NULL DEFAULT '{}',
  edited_fields jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_processes_mission_id ON processes (mission_id);

CREATE TABLE process_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  process_id uuid NOT NULL REFERENCES processes (id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  label text NOT NULL,
  actor varchar(120),
  tool varchar(120),
  is_manual boolean NOT NULL DEFAULT false,
  is_reentry boolean NOT NULL DEFAULT false,
  requires_validation boolean NOT NULL DEFAULT false,
  line integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_process_steps_process_id ON process_steps (process_id);

CREATE TABLE graph_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  kind varchar(24) NOT NULL,
  key varchar(160) NOT NULL,                      -- stable natural key, e.g. "tool:excel"
  label varchar(200) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  origin varchar(16) NOT NULL DEFAULT 'engine',   -- engine | user
  x double precision,
  y double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_graph_nodes_mission_id ON graph_nodes (mission_id);

CREATE TABLE graph_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES graph_nodes (id) ON DELETE CASCADE,
  relation varchar(32) NOT NULL,
  label varchar(200),
  weight double precision NOT NULL DEFAULT 1,
  properties jsonb NOT NULL DEFAULT '{}',
  origin varchar(16) NOT NULL DEFAULT 'engine',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_graph_edges_mission_id ON graph_edges (mission_id);
CREATE INDEX ix_graph_edges_source_id ON graph_edges (source_id);
CREATE INDEX ix_graph_edges_target_id ON graph_edges (target_id);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents (id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL,                      -- excerpt | rows | aggregate | document
  locator jsonb NOT NULL DEFAULT '{}',
  excerpt text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  value jsonb NOT NULL DEFAULT '{}',
  relevance double precision NOT NULL DEFAULT 0.5,
  origin varchar(16) NOT NULL DEFAULT 'engine',   -- engine | user
  detector varchar(64),
  ordinal integer NOT NULL DEFAULT 0,             -- creation order within an analysis run
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_evidence_mission_id ON evidence (mission_id);

CREATE TABLE evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  evidence_id uuid NOT NULL REFERENCES evidence (id) ON DELETE CASCADE,
  target_type varchar(24) NOT NULL,
  target_id uuid NOT NULL,
  stance varchar(12) NOT NULL DEFAULT 'supports',
  ordinal integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_evidence_links_mission_id ON evidence_links (mission_id);
CREATE INDEX ix_evidence_links_target ON evidence_links (target_type, target_id);
CREATE INDEX ix_evidence_links_evidence_id ON evidence_links (evidence_id);

CREATE TABLE pain_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  code varchar(64) NOT NULL,                      -- detector key, stable across re-analyses
  title varchar(300) NOT NULL,
  description text NOT NULL,
  type varchar(32) NOT NULL,
  department varchar(120),
  scope varchar(300),
  frequency varchar(200),
  frequency_per_month double precision,
  impact text,
  impact_mad_per_year double precision,
  confidence double precision NOT NULL DEFAULT 0.5,
  criticality varchar(16) NOT NULL,
  severity double precision NOT NULL DEFAULT 0,
  is_hypothesis boolean NOT NULL DEFAULT false,
  process_id uuid REFERENCES processes (id) ON DELETE SET NULL,
  ordinal integer NOT NULL DEFAULT 0,
  validation_status varchar(16) NOT NULL DEFAULT 'a_verifier',
  validated_at timestamptz,
  validated_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  generated jsonb NOT NULL DEFAULT '{}',
  edited_fields jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pain_points_mission_id ON pain_points (mission_id);

CREATE TABLE metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  pain_point_id uuid REFERENCES pain_points (id) ON DELETE CASCADE,
  key varchar(80) NOT NULL,
  label varchar(300) NOT NULL,
  value double precision NOT NULL,
  unit varchar(24) NOT NULL DEFAULT '',
  nature varchar(16) NOT NULL DEFAULT 'calcul',   -- fait | calcul | hypothese
  formula text NOT NULL DEFAULT '',
  inputs jsonb NOT NULL DEFAULT '{}',
  ordinal integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_metrics_mission_id ON metrics (mission_id);
CREATE INDEX ix_metrics_pain_point_id ON metrics (pain_point_id);

CREATE TABLE risks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  title varchar(300) NOT NULL,
  description text NOT NULL,
  kind varchar(32) NOT NULL,
  likelihood double precision NOT NULL DEFAULT 0.5,
  severity varchar(16) NOT NULL,
  exposure_mad_per_year double precision,
  pain_point_id uuid REFERENCES pain_points (id) ON DELETE SET NULL,
  validation_status varchar(16) NOT NULL DEFAULT 'a_verifier',
  validated_at timestamptz,
  validated_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  generated jsonb NOT NULL DEFAULT '{}',
  edited_fields jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_risks_mission_id ON risks (mission_id);

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  code varchar(64) NOT NULL,
  title varchar(300) NOT NULL,
  summary text NOT NULL,
  category varchar(32) NOT NULL,
  category_rationale text NOT NULL DEFAULT '',
  department varchar(120),
  effort varchar(16) NOT NULL,
  target_delivery varchar(40),
  scores jsonb NOT NULL DEFAULT '{}',
  priority_score double precision NOT NULL DEFAULT 0,
  priority_rank integer,
  priority_label varchar(8),
  architecture jsonb NOT NULL DEFAULT '[]',
  pilot_plan jsonb NOT NULL DEFAULT '[]',
  kpis jsonb NOT NULL DEFAULT '[]',
  confidence double precision NOT NULL DEFAULT 0.5,
  validation_status varchar(16) NOT NULL DEFAULT 'a_verifier',
  validated_at timestamptz,
  validated_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  generated jsonb NOT NULL DEFAULT '{}',
  edited_fields jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_opportunities_mission_id ON opportunities (mission_id);

CREATE TABLE opportunity_pain_points (
  opportunity_id uuid NOT NULL REFERENCES opportunities (id) ON DELETE CASCADE,
  pain_point_id uuid NOT NULL REFERENCES pain_points (id) ON DELETE CASCADE,
  PRIMARY KEY (opportunity_id, pain_point_id)
);

CREATE TABLE assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES opportunities (id) ON DELETE CASCADE,
  key varchar(64) NOT NULL,
  label varchar(300) NOT NULL,
  value double precision NOT NULL,
  default_value double precision NOT NULL,
  unit varchar(24) NOT NULL DEFAULT '',
  nature varchar(16) NOT NULL,
  source text NOT NULL DEFAULT '',
  metric_id uuid REFERENCES metrics (id) ON DELETE SET NULL,
  confidence double precision NOT NULL DEFAULT 0.5,
  "group" varchar(16) NOT NULL DEFAULT 'actuel',  -- actuel | cible | couts
  min_value double precision,
  max_value double precision,
  ordinal integer NOT NULL DEFAULT 0,
  validation_status varchar(16) NOT NULL DEFAULT 'a_verifier',
  validated_at timestamptz,
  validated_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  generated jsonb NOT NULL DEFAULT '{}',
  edited_fields jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_assumptions_opportunity_id ON assumptions (opportunity_id);
CREATE INDEX ix_assumptions_mission_id ON assumptions (mission_id);

CREATE TABLE roi_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL UNIQUE REFERENCES opportunities (id) ON DELETE CASCADE,
  model_type varchar(32) NOT NULL DEFAULT 'composite',
  results jsonb NOT NULL DEFAULT '{}',
  breakdown jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_roi_models_mission_id ON roi_models (mission_id);

CREATE TABLE recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities (id) ON DELETE CASCADE,
  title varchar(300) NOT NULL,
  text text NOT NULL,
  ordinal integer NOT NULL DEFAULT 0,
  validation_status varchar(16) NOT NULL DEFAULT 'a_verifier',
  validated_at timestamptz,
  validated_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  generated jsonb NOT NULL DEFAULT '{}',
  edited_fields jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_recommendations_mission_id ON recommendations (mission_id);

CREATE TABLE roadmap_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities (id) ON DELETE CASCADE,
  title varchar(300) NOT NULL,
  description text NOT NULL DEFAULT '',
  phase varchar(8) NOT NULL,
  kind varchar(24) NOT NULL,
  start_week integer NOT NULL DEFAULT 0,
  duration_weeks integer NOT NULL DEFAULT 4,
  owner varchar(120),
  depends_on jsonb NOT NULL DEFAULT '[]',
  ordinal integer NOT NULL DEFAULT 0,
  validation_status varchar(16) NOT NULL DEFAULT 'a_verifier',
  validated_at timestamptz,
  validated_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  generated jsonb NOT NULL DEFAULT '{}',
  edited_fields jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_roadmap_items_mission_id ON roadmap_items (mission_id);

-- Collaboration -------------------------------------------------------------------------------------------

CREATE TABLE validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  target_type varchar(24) NOT NULL,
  target_id uuid NOT NULL,
  status varchar(16) NOT NULL,
  comment text,
  changes jsonb NOT NULL DEFAULT '{}',            -- field -> {before, after}
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  user_name varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_validations_mission_id ON validations (mission_id);
CREATE INDEX ix_validations_target ON validations (target_type, target_id);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  target_type varchar(24) NOT NULL,
  target_id uuid NOT NULL,
  kind varchar(16) NOT NULL DEFAULT 'comment',    -- comment | contestation
  body text NOT NULL,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  user_name varchar(200),
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_comments_mission_id ON comments (mission_id);
CREATE INDEX ix_comments_target ON comments (target_type, target_id);

CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid NOT NULL REFERENCES audit_missions (id) ON DELETE CASCADE,
  format varchar(8) NOT NULL,
  storage_key varchar(512) NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  sha256 varchar(64) NOT NULL,
  analysis_version integer NOT NULL DEFAULT 0,
  published boolean NOT NULL DEFAULT false,       -- the frozen deliverable clients can read
  created_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_exports_mission_id ON exports (mission_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mission_id uuid REFERENCES audit_missions (id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL,                      -- ingest | analyze | export
  status varchar(16) NOT NULL,                    -- queued | running | succeeded | failed
  progress double precision NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  done integer NOT NULL DEFAULT 0,
  message text,
  error text,
  payload jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_jobs_mission_id ON jobs (mission_id);

-- updated_at maintenance ----------------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_updated_at', t);
  END LOOP;
END;
$$;
