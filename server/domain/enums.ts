/** Domain vocabularies (spec §5.2, §5.4, §5.5, §13), stored as plain strings in the database. */

export const Role = { admin: "admin", consultant: "consultant", executive: "executive", business_owner: "business_owner" } as const;
export type Role = (typeof Role)[keyof typeof Role];
export const WRITE_ROLES: ReadonlySet<Role> = new Set([Role.admin, Role.consultant]);
export const CLIENT_ROLES: ReadonlySet<Role> = new Set([Role.executive, Role.business_owner]);

export const MissionStatus = { draft: "draft", ingesting: "ingesting", analyzing: "analyzing", review: "review", published: "published" } as const;
export type MissionStatus = (typeof MissionStatus)[keyof typeof MissionStatus];

export const DocumentStatus = { received: "received", parsed: "parsed", indexed: "indexed", error: "error", duplicate: "duplicate" } as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];

export const DOCUMENT_CATEGORIES = [
  "finance", "ventes", "achats", "operations", "rh", "contrats", "procedures", "qualite", "maintenance", "support", "reporting", "it_securite", "autre",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const ValidationStatus = { a_verifier: "a_verifier", valide: "valide", corrige: "corrige", rejete: "rejete" } as const;
export type ValidationStatus = (typeof ValidationStatus)[keyof typeof ValidationStatus];
export const VALIDATION_STATUSES = Object.values(ValidationStatus);

export const PainPointType = {
  double_saisie: "double_saisie",
  tache_manuelle: "tache_manuelle",
  delai: "delai",
  rupture_flux: "rupture_flux",
  donnee_contradictoire: "donnee_contradictoire",
  dependance_personne: "dependance_personne",
  absence_controle: "absence_controle",
  non_respect_sla: "non_respect_sla",
  stock_cash_immobilise: "stock_cash_immobilise",
  reporting_tardif: "reporting_tardif",
  manque_tracabilite: "manque_tracabilite",
  risque_contractuel: "risque_contractuel",
  potentiel_commercial: "potentiel_commercial",
} as const;
export type PainPointType = (typeof PainPointType)[keyof typeof PainPointType];

export const Criticality = { critique: "critique", elevee: "elevee", moyenne: "moyenne", faible: "faible" } as const;
export type Criticality = (typeof Criticality)[keyof typeof Criticality];

export const OpportunityCategory = {
  automatisation: "automatisation",
  integration_si: "integration_si",
  amelioration_processus: "amelioration_processus",
  bi_data: "bi_data",
  assistant_ia: "assistant_ia",
  agent_ia: "agent_ia",
  rag: "rag",
  prediction_optimisation: "prediction_optimisation",
  nouveau_service: "nouveau_service",
} as const;
export type OpportunityCategory = (typeof OpportunityCategory)[keyof typeof OpportunityCategory];
export const AI_CATEGORIES: ReadonlySet<string> = new Set(["assistant_ia", "agent_ia", "rag", "prediction_optimisation"]);

export const EffortLevel = { faible: "faible", moyen: "moyen", eleve: "eleve" } as const;
export type EffortLevel = (typeof EffortLevel)[keyof typeof EffortLevel];

export const AssumptionNature = { fait: "fait", calcul: "calcul", hypothese: "hypothese" } as const;
export type AssumptionNature = (typeof AssumptionNature)[keyof typeof AssumptionNature];

export const RoadmapPhase = { j30: "j30", j60: "j60", j90: "j90", t2: "t2", t3: "t3", t4: "t4" } as const;
export type RoadmapPhase = (typeof RoadmapPhase)[keyof typeof RoadmapPhase];

export const JobStatus = { queued: "queued", running: "running", done: "done", error: "error" } as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const JobKind = { ingest: "ingest", analyze: "analyze", export: "export" } as const;
export type JobKind = (typeof JobKind)[keyof typeof JobKind];

export const EvidenceKind = { excerpt: "excerpt", rows: "rows", aggregate: "aggregate", document: "document" } as const;
export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

export const GraphNodeKind = {
  department: "department", role: "role", tool: "tool", process: "process", data: "data", kpi: "kpi", contract: "contract", sla: "sla",
} as const;
export type GraphNodeKind = (typeof GraphNodeKind)[keyof typeof GraphNodeKind];

export const GraphRelation = {
  uses: "uses",
  consumes: "consumes",
  produces: "produces",
  depends_on: "depends_on",
  imposes: "imposes",
  requires_validation: "requires_validation",
  generates_reentry: "generates_reentry",
  duplicated_in: "duplicated_in",
  owns: "owns",
} as const;
export type GraphRelation = (typeof GraphRelation)[keyof typeof GraphRelation];

/** Entities that can carry evidence, validations and comments. */
export const TargetType = {
  pain_point: "pain_point",
  opportunity: "opportunity",
  assumption: "assumption",
  metric: "metric",
  risk: "risk",
  process: "process",
  recommendation: "recommendation",
  roadmap_item: "roadmap_item",
  graph_node: "graph_node",
  graph_edge: "graph_edge",
} as const;
export type TargetType = (typeof TargetType)[keyof typeof TargetType];
