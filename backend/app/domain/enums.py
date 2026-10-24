"""Domain vocabularies (spec §5.2, §5.4, §5.5, §13). Stored as plain strings in the database."""

from enum import StrEnum


class Role(StrEnum):
    admin = "admin"
    consultant = "consultant"
    executive = "executive"  # dirigeant client
    business_owner = "business_owner"  # responsable métier


class MissionStatus(StrEnum):
    draft = "draft"
    ingesting = "ingesting"
    analyzing = "analyzing"
    review = "review"
    published = "published"


class DocumentStatus(StrEnum):
    received = "received"
    parsed = "parsed"
    indexed = "indexed"
    error = "error"
    duplicate = "duplicate"


class DocumentCategory(StrEnum):
    finance = "finance"
    ventes = "ventes"
    achats = "achats"
    operations = "operations"
    rh = "rh"
    contrats = "contrats"
    procedures = "procedures"
    qualite = "qualite"
    maintenance = "maintenance"
    support = "support"
    reporting = "reporting"
    it_securite = "it_securite"
    autre = "autre"


class ValidationStatus(StrEnum):
    a_verifier = "a_verifier"
    valide = "valide"
    corrige = "corrige"
    rejete = "rejete"


class PainPointType(StrEnum):
    double_saisie = "double_saisie"
    tache_manuelle = "tache_manuelle"
    delai = "delai"
    rupture_flux = "rupture_flux"
    donnee_contradictoire = "donnee_contradictoire"
    dependance_personne = "dependance_personne"
    absence_controle = "absence_controle"
    non_respect_sla = "non_respect_sla"
    stock_cash_immobilise = "stock_cash_immobilise"
    reporting_tardif = "reporting_tardif"
    manque_tracabilite = "manque_tracabilite"
    risque_contractuel = "risque_contractuel"
    potentiel_commercial = "potentiel_commercial"


class Criticality(StrEnum):
    critique = "critique"
    elevee = "elevee"
    moyenne = "moyenne"
    faible = "faible"


class OpportunityCategory(StrEnum):
    automatisation = "automatisation"
    integration_si = "integration_si"
    amelioration_processus = "amelioration_processus"
    bi_data = "bi_data"
    assistant_ia = "assistant_ia"
    agent_ia = "agent_ia"
    rag = "rag"
    prediction_optimisation = "prediction_optimisation"
    nouveau_service = "nouveau_service"


AI_CATEGORIES = frozenset(
    {
        OpportunityCategory.assistant_ia,
        OpportunityCategory.agent_ia,
        OpportunityCategory.rag,
        OpportunityCategory.prediction_optimisation,
    }
)


class EffortLevel(StrEnum):
    faible = "faible"
    moyen = "moyen"
    eleve = "eleve"


class AssumptionNature(StrEnum):
    fait = "fait"  # read directly from a source, with evidence
    calcul = "calcul"  # deterministic computation over facts
    hypothese = "hypothese"  # benchmark or estimate to be validated


class RoadmapPhase(StrEnum):
    j30 = "j30"
    j60 = "j60"
    j90 = "j90"
    t2 = "t2"  # months 4-6
    t3 = "t3"  # months 7-9
    t4 = "t4"  # months 10-12


class JobStatus(StrEnum):
    queued = "queued"
    running = "running"
    done = "done"
    error = "error"


class JobKind(StrEnum):
    ingest = "ingest"
    analyze = "analyze"
    export = "export"


class EvidenceKind(StrEnum):
    excerpt = "excerpt"  # text lines from a document
    rows = "rows"  # rows of a table
    aggregate = "aggregate"  # computed over a table column (formula + inputs)
    document = "document"  # whole document metadata (e.g. last update date)


class GraphNodeKind(StrEnum):
    department = "department"
    role = "role"
    tool = "tool"
    process = "process"
    data = "data"
    kpi = "kpi"
    contract = "contract"
    sla = "sla"


class GraphRelation(StrEnum):
    uses = "uses"  # team uses tool
    consumes = "consumes"  # process consumes data
    produces = "produces"
    depends_on = "depends_on"  # KPI depends on a file
    imposes = "imposes"  # contract imposes SLA
    requires_validation = "requires_validation"
    generates_reentry = "generates_reentry"
    duplicated_in = "duplicated_in"  # data exists in several systems
    owns = "owns"


class TargetType(StrEnum):
    """Entities that can carry evidence, validations and comments."""

    pain_point = "pain_point"
    opportunity = "opportunity"
    assumption = "assumption"
    metric = "metric"
    risk = "risk"
    process = "process"
    recommendation = "recommendation"
    roadmap_item = "roadmap_item"
    graph_node = "graph_node"
    graph_edge = "graph_edge"
