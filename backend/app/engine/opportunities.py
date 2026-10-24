"""Opportunity generation (spec §5.5) and business-case assumptions (spec §7).

Each pain point maps to a remedy template. A template:
  - picks its category with `choose_category`, which refuses AI when a simple automation suffices
    (AI only for unstructured inputs, optimisation or prediction needs that the evidence supports);
  - builds value lines over named assumptions, each labelled fait / calcul / hypothèse with its source;
  - never invents a fact: what the sources do not say is a hypothesis with a stated rationale.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from app.domain.enums import AI_CATEGORIES, AssumptionNature, EffortLevel
from app.domain.enums import OpportunityCategory as C
from app.engine.benchmarks import bench
from app.engine.context import Dataset, median
from app.engine.detectors import Env, Finding, period_months
from app.engine.fmt import n0, n1
from app.engine.roi import ValueLine

F, CALC, H = AssumptionNature.fait, AssumptionNature.calcul, AssumptionNature.hypothese

# Benchmarks (hypotheses, editable on every business case). Project cost covers build, integration,
# tests and change management; run cost covers licences, hosting, model usage and maintenance.
PROJECT_COST = {EffortLevel.faible: 60_000, EffortLevel.moyen: 150_000, EffortLevel.eleve: 350_000}
RUN_COST_MONTH = {
    C.automatisation: 800,
    C.integration_si: 1_500,
    C.amelioration_processus: 0,
    C.bi_data: 1_500,
    C.assistant_ia: 2_000,
    C.agent_ia: 3_000,
    C.rag: 2_500,
    C.prediction_optimisation: 3_000,
    C.nouveau_service: 2_000,
}
DELIVERY = {EffortLevel.faible: "4-6 sem.", EffortLevel.moyen: "8-12 sem.", EffortLevel.eleve: "12-16 sem."}


@dataclass
class AssumptionSpec:
    key: str
    label: str
    value: float
    unit: str
    nature: str
    source: str
    group: str = "actuel"  # actuel | cible | couts
    metric_key: str | None = None  # metric of the linked pain point this value comes from
    confidence: float = 0.5
    min_value: float | None = None
    max_value: float | None = None


@dataclass
class OpportunitySpec:
    code: str
    title: str
    summary: str
    category: str
    category_rationale: str
    effort: str
    pain_codes: list[str]
    lines: list[ValueLine]
    assumptions: list[AssumptionSpec]
    department: str | None = None
    target_delivery: str | None = None
    architecture: list[str] = field(default_factory=list)
    pilot_plan: list[dict] = field(default_factory=list)
    kpis: list[str] = field(default_factory=list)
    risk_reduction: float = 0.3  # 0-1, qualitative contribution to risk reduction
    data_readiness: float = 0.7  # 0-1, set from the evidence available
    compliance: float = 0.2  # 0-1, sensitivity of the data processed
    departments_involved: int = 1


def choose_category(
    preferred: str,
    *,
    unstructured: bool = False,
    optimisation: bool = False,
    prediction: bool = False,
    fallback: str = C.automatisation,
) -> tuple[str, str]:
    """Spec §5.5: never recommend AI when a simple automation is enough."""
    if preferred in (C.assistant_ia, C.rag, C.agent_ia) and not unstructured:
        return (
            fallback,
            "Les données en jeu sont structurées : une automatisation déterministe suffit, sans IA.",
        )
    if preferred == C.prediction_optimisation and not (optimisation or prediction):
        return (
            fallback,
            "Aucun besoin de prédiction ni d'optimisation sous contraintes : des règles et tableaux de bord suffisent.",
        )
    reasons = {
        C.assistant_ia: "IA justifiée : les entrées sont non structurées (emails, messages, textes libres) et doivent être interprétées.",
        C.rag: "IA justifiée : la connaissance est dispersée dans des textes libres qu'il faut retrouver et citer.",
        C.agent_ia: "IA justifiée : la tâche enchaîne lecture de messages et actions dans plusieurs outils.",
        C.prediction_optimisation: "Optimisation justifiée : arbitrages sous contraintes multiples qu'un tableur ne peut pas résoudre."
        if optimisation
        else "Prédiction justifiée : décision dépendante d'un historique à apprendre.",
    }
    return preferred, reasons.get(
        preferred, "Gain obtenu par des règles, intégrations et tableaux de bord : pas d'IA nécessaire."
    )


# --- shared assumption builders ---------------------------------------------------------------------


def _dept_size(env: Env, *keywords: str) -> int | None:
    for name, info in env.ex.org.departments.items():
        if any(k in name.lower() for k in keywords):
            return info.headcount or None
    return None


def _plausible(env: Env, ds: Dataset, p: int) -> tuple[bool, str]:
    kind = ds.kind
    revenue = env.ctx.mission.organization.revenue_mad or 0
    if kind == "quotes":
        staff = _dept_size(env, "commerc", "adv", "vente") or 5
        return ds.n / (staff * p) <= 40, f"{ds.n} devis pour {staff} commerciaux, ≤ 40 devis/personne/mois"
    if kind == "tickets":
        staff = _dept_size(env, "sav", "support", "relation client", "service client") or 5
        return ds.n / (staff * p) <= 250, f"{ds.n} tickets pour {staff} personnes au support"
    if kind == "interventions":
        staff = _dept_size(env, "technicien", "exploitation") or 5
        return ds.n / (
            staff * p
        ) <= 80, f"{ds.n} interventions pour {staff} techniciens, ≤ 80/technicien/mois"
    if kind == "purchases" and ds.has("amount") and revenue:
        total = sum(a or 0 for a in ds.numbers("amount"))
        return total / (revenue / 12 * p) <= 0.35, f"achats de {n0(total)} MAD ≤ 35 % du CA de la période"
    if kind == "production" and ds.has("actual_hours"):
        lines = len(set(ds.values("line"))) if ds.has("line") else 1
        hours = sum(h or 0 for h in ds.numbers("actual_hours"))
        return hours / (lines * 720 * p) <= 0.85, f"{n0(hours)} h sur {lines} ligne(s), taux de charge ≤ 85 %"
    if kind == "maintenance" and ds.has("downtime_hours"):
        machines = len(set(ds.values("machine"))) if ds.has("machine") else 1
        down = sum(h or 0 for h in ds.numbers("downtime_hours"))
        return down / (
            machines * 720 * p
        ) <= 0.05, f"{n0(down)} h d'arrêt sur {machines} machines, disponibilité ≥ 95 %"
    if kind == "non_conformities":
        prod = env.ctx.dataset("production")
        if prod is not None:
            prod_p, _, _ = extract_period(env, prod)
            per_month = prod.n / prod_p
            return (
                ds.n / p <= 0.25 * per_month,
                f"≤ 1 non-conformité pour 4 ordres de fabrication ({n1(per_month)} OF/mois)",
            )
        return ds.n / p <= 10, "≤ 10 non-conformités par mois"
    return True, "pas de contrainte de plausibilité"


def extract_period(env: Env, ds: Dataset) -> tuple[float, str, str]:
    """Months covered by a dataset: from its dates when present, else the shortest plausible period."""
    months = period_months(ds)
    if months:
        return (
            months,
            CALC,
            f"Période couverte par {ds.document.filename} : {n1(months)} mois (dates min–max).",
        )
    override = env.params.get(f"period_months:{ds.kind}") or env.params.get("extract_period_months")
    if override:
        return float(override), H, "Période de l'extrait fixée par le consultant."
    for p in (1, 3, 6, 12):
        ok, why = _plausible(env, ds, p)
        if ok:
            return (
                float(p),
                H,
                (
                    f"Période de {ds.document.filename} non précisée : {p} mois retenu(s), plus courte période "
                    f"plausible ({why}). À confirmer."
                ),
            )
    return 12.0, H, f"Période de {ds.document.filename} non précisée : 12 mois retenus par prudence."


def _hourly(env: Env) -> AssumptionSpec:
    b = bench("hourly_cost_mad", env.params)
    given = "hourly_cost_mad" in env.params
    return AssumptionSpec(
        "hourly_cost_mad",
        "Coût horaire chargé",
        b,
        "MAD/h",
        F if given else H,
        "Fourni par le client."
        if given
        else "Coût moyen chargé d'un employé administratif (benchmark, à confirmer avec la DRH).",
        "actuel",
        confidence=0.8 if given else 0.5,
        min_value=50,
        max_value=1_000,
    )


def _costs(category: str, effort: str) -> list[AssumptionSpec]:
    return [
        AssumptionSpec(
            "project_cost",
            "Coût projet (build + conduite du changement)",
            PROJECT_COST[EffortLevel(effort)],
            "MAD",
            H,
            f"Benchmark pour un effort « {effort} » : intégration, paramétrage, tests, formation.",
            "couts",
            min_value=0,
        ),
        AssumptionSpec(
            "run_cost_month",
            "Coût récurrent (licences, hébergement, maintenance)",
            RUN_COST_MONTH[C(category)],
            "MAD/mois",
            H,
            f"Benchmark pour une solution « {category} ».",
            "couts",
            min_value=0,
        ),
    ]


def _metric(f: Finding, key: str) -> float | None:
    return next((m.value for m in f.metrics if m.key == key), None)


def _volume(env: Env, ds: Dataset, unit: str, label: str, count: int | None = None) -> list[AssumptionSpec]:
    months, nature, rationale = extract_period(env, ds)
    n = ds.n if count is None else count
    return [
        AssumptionSpec(
            "period_months",
            "Période couverte par les données",
            months,
            "mois",
            nature,
            rationale,
            "actuel",
            confidence=0.9 if nature == CALC else 0.4,
            min_value=0.5,
            max_value=36,
        ),
        AssumptionSpec(
            "records",
            f"{label} dans les données",
            n,
            unit,
            F,
            f"Décompte dans {ds.document.filename}.",
            "actuel",
            confidence=0.95,
        ),
    ]


def _unstructured(env: Env, pattern: str, categories: tuple[str, ...] | None = None) -> bool:
    return bool(env.ctx.grep(pattern, categories))


def _pilot(*steps: tuple[str, int]) -> list[dict]:
    return [{"step": s, "weeks": w} for s, w in steps]


# --- templates --------------------------------------------------------------------------------------


def quote_copilot(env: Env, f: Finding) -> OpportunitySpec:
    ds = next(d for d in env.ctx.datasets if d.label == f.signals["dataset"])
    email_intake = _unstructured(env, r"demande.*(email|mail|courriel)|par email", ("procedures", "ventes"))
    category, rationale = choose_category(C.assistant_ia, unstructured=email_intake)
    ai = category in AI_CATEGORIES
    med = f.signals.get("median_minutes") or 30
    assumptions = [
        *_volume(env, ds, "devis", "Devis"),
        AssumptionSpec(
            "minutes",
            "Temps médian de préparation d'un devis",
            med,
            "min",
            CALC,
            f"Médiane de {ds.column('prep_minutes')} dans {ds.document.filename}."
            if ds.has("prep_minutes")
            else "Hypothèse",
            "actuel",
            metric_key="median_minutes",
            confidence=0.9,
        ),
        AssumptionSpec(
            "automation",
            "Part du temps de préparation automatisée",
            0.65,
            "ratio",
            H,
            "Pré-remplissage depuis la demande, le catalogue et la grille tarifaire ; la validation reste humaine.",
            "cible",
            confidence=0.5,
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "adoption",
            "Taux d'adoption par les commerciaux",
            0.85,
            "ratio",
            H,
            "Adoption après pilote et formation.",
            "cible",
            confidence=0.5,
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.faible),
    ]
    # Monthly volume = records × (1 / period): the period is its own assumption, so it stays editable.
    lines = [
        ValueLine(
            "prep_time",
            "Temps de préparation économisé",
            "time",
            ("records", "per_period", "minutes", "automation", "adoption"),
            "hourly_cost_mad",
            scale=1 / 60,
        )
    ]
    assumptions.append(_per_period(assumptions))
    templates = f.signals.get("templates") or 0
    return OpportunitySpec(
        code="opp:quote_copilot",
        title="Copilote de devis" if ai else f"Modèle de {ds.label.lower()} unique connecté au catalogue",
        summary=(
            f"Préparer automatiquement le premier jet du devis (références, prix, conditions) à partir de la demande client, "
            f"sur un modèle unique{f' au lieu de {templates}' if templates > 1 else ''}, puis synchroniser l'ERP pour supprimer la ressaisie. "
            "Le commercial valide avant envoi."
        ),
        category=category,
        category_rationale=rationale
        + (
            " La génération du devis et la synchronisation ERP restent des règles déterministes."
            if ai
            else ""
        ),
        effort=EffortLevel.faible,
        target_delivery="6-8 sem.",
        pain_codes=[f.code],
        lines=lines,
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Réception des demandes (email / portail)",
            "Extraction assistée des besoins (LLM, données masquées)"
            if ai
            else "Formulaire de demande structuré",
            "Catalogue et grille tarifaire (export / API ERP)",
            "Modèle de devis unique",
            "Validation commerciale",
            "Synchronisation ERP (fin de la ressaisie)",
        ],
        pilot_plan=_pilot(
            ("Cadrage : modèle unique et règles de prix", 2),
            ("Connecteur catalogue / ERP", 2),
            ("Pilote avec 3 commerciaux", 3),
            ("Mesure : temps de préparation, taux de ressaisie", 1),
        ),
        kpis=[
            "Temps médian de préparation",
            "Taux de ressaisie manuelle",
            "Délai d'envoi du devis",
            "Taux de transformation",
        ],
        risk_reduction=0.3,
        data_readiness=0.85,
        compliance=0.25,
    )


def _per_period(assumptions: list[AssumptionSpec]) -> AssumptionSpec:
    months = next(a.value for a in assumptions if a.key == "period_months")
    return AssumptionSpec(
        "per_period",
        "Mensualisation (1 / période en mois)",
        round(1 / months, 6),
        "1/mois",
        CALC,
        "Calcul : 1 / période couverte par les données.",
        "actuel",
        confidence=0.9,
    )


def data_entry_automation(env: Env, f: Finding) -> OpportunitySpec:
    ds = next(d for d in env.ctx.datasets if d.label == f.signals["dataset"])
    category, rationale = choose_category(C.automatisation)
    med = f.signals.get("median_minutes") or 10
    assumptions = [
        *_volume(env, ds, "enregistrements", ds.label),
        AssumptionSpec(
            "minutes",
            "Temps de saisie par enregistrement",
            med,
            "min",
            CALC if f.signals.get("median_minutes") else H,
            "Médiane observée." if f.signals.get("median_minutes") else "Hypothèse : 10 min de saisie.",
            "actuel",
            metric_key="median_minutes",
        ),
        AssumptionSpec(
            "manual_rate",
            "Part des enregistrements ressaisis",
            f.signals["manual_rate"],
            "ratio",
            CALC,
            "Calcul sur les données.",
            "actuel",
            metric_key="manual_rate",
            confidence=0.9,
        ),
        AssumptionSpec(
            "automation",
            "Part de la saisie supprimée",
            0.8,
            "ratio",
            H,
            "Intégration entre systèmes.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code=f"opp:entry_automation:{ds.kind or ds.table.name}",
        title=f"Suppression de la ressaisie — {ds.label}",
        summary=f"Connecter les systèmes pour que les {ds.label.lower()} ne soient saisis qu'une fois.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.moyen,
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "entry",
                "Temps de ressaisie supprimé",
                "time",
                ("records", "per_period", "manual_rate", "minutes", "automation"),
                "hourly_cost_mad",
                scale=1 / 60,
            )
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=["Connecteur entre systèmes", "Règles de contrôle", "Journal des synchronisations"],
        pilot_plan=_pilot(("Cartographie des champs", 2), ("Connecteur", 4), ("Recette", 2)),
        kpis=["Taux de ressaisie", "Erreurs de saisie"],
    )


def quote_followup(env: Env, f: Finding) -> OpportunitySpec:
    ds = env.ctx.dataset("quotes")
    category, rationale = choose_category(C.automatisation)
    rec = env.ctx.dataset("receivables")
    margin = median(rec.numbers("margin_pct")) if rec is not None and rec.has("margin_pct") else None
    assumptions = [
        *_volume(env, ds, "devis", "Devis"),
        AssumptionSpec(
            "pending_value",
            "Montant des devis en attente",
            round(f.signals["pending_value"]),
            "MAD",
            F,
            f"Somme des montants au statut en attente dans {ds.document.filename}.",
            "actuel",
            metric_key="pending_value",
            confidence=0.95,
        ),
        AssumptionSpec(
            "uplift",
            "Gain de transformation sur les devis en attente",
            0.02,
            "ratio",
            H,
            "Relances programmées et suivi du pipeline : +2 points de transformation (hypothèse prudente).",
            "cible",
            min_value=0,
            max_value=0.3,
        ),
        AssumptionSpec(
            "margin",
            "Marge brute moyenne",
            round(margin, 4) if margin else 0.2,
            "ratio",
            CALC if margin else H,
            "Médiane de la marge brute des factures clients."
            if margin
            else "Hypothèse de marge brute de 20 %.",
            "actuel",
            confidence=0.8 if margin else 0.4,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.faible),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code="opp:quote_followup",
        title="Relances commerciales des devis en attente",
        summary="Relancer automatiquement les devis sans réponse selon leur montant et leur ancienneté, et suivre le pipeline dans un tableau de bord partagé.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.faible,
        target_delivery="4-6 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "margin_gain",
                "Marge supplémentaire sur devis transformés",
                "product",
                ("pending_value", "per_period", "uplift", "margin"),
                family="revenue",
            )
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Statuts de devis dans le CRM/ERP",
            "Règles de relance (J+3, J+10)",
            "Tableau de bord pipeline",
        ],
        pilot_plan=_pilot(("Règles de relance", 1), ("Automatisation emails", 2), ("Tableau de bord", 1)),
        kpis=["Taux de transformation", "Délai de décision client", "Devis en attente > 30 jours"],
        data_readiness=0.8,
    )


def receivables_priority(env: Env, f: Finding) -> OpportunitySpec:
    s = f.signals
    category, rationale = choose_category(C.automatisation)
    months = s.get("period_months") or 12
    assumptions = [
        AssumptionSpec(
            "overdue_amount",
            "Créances échues",
            round(s["overdue_amount"]),
            "MAD",
            F,
            "Somme des factures au statut échu.",
            "actuel",
            metric_key="overdue_amount",
            confidence=0.95,
        ),
        AssumptionSpec(
            "late60_amount",
            "Créances échues depuis 60 jours ou plus",
            round(s["late60_amount"]),
            "MAD",
            F,
            "Somme des factures échues avec un retard ≥ 60 jours.",
            "actuel",
            metric_key="late60_amount",
            confidence=0.95,
        ),
        AssumptionSpec(
            "overdue_per_month",
            "Factures échues par mois",
            round(s["overdue_count"] / months, 2),
            "factures/mois",
            CALC,
            f"{s['overdue_count']} factures échues sur {n1(months)} mois de données.",
            "actuel",
            confidence=0.85,
        ),
        AssumptionSpec(
            "cost_of_capital",
            "Coût du capital",
            bench("cost_of_capital", env.params),
            "/an",
            H,
            "Taux de financement court terme (hypothèse à valider avec la DAF).",
            "actuel",
            min_value=0,
            max_value=0.3,
        ),
        AssumptionSpec(
            "dso_reduction",
            "Réduction des retards de paiement",
            0.25,
            "ratio",
            H,
            "Relances priorisées par marge × montant × historique : −25 % d'encours échu (hypothèse).",
            "cible",
            min_value=0,
            max_value=0.8,
        ),
        AssumptionSpec(
            "loss_avoided",
            "Pertes sur créances évitées (sur les > 60 j)",
            0.05,
            "ratio",
            H,
            "Part des créances anciennes qui serait passée en perte sans relance ciblée.",
            "cible",
            min_value=0,
            max_value=0.5,
        ),
        AssumptionSpec(
            "followup_minutes",
            "Temps de relance par facture échue",
            40,
            "min",
            H,
            "Recherche de l'historique, appel, email, mise à jour.",
            "actuel",
        ),
        AssumptionSpec(
            "automation",
            "Part du temps de relance automatisée",
            0.5,
            "ratio",
            H,
            "Relances et historique générés automatiquement.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    return OpportunitySpec(
        code="opp:receivables_priority",
        title="Priorisation des relances d'impayés (marge × risque × ancienneté)",
        summary=(
            "Ordonner chaque jour les relances selon le montant, la marge, l'ancienneté et l'historique de paiement du client, générer "
            "les relances et tracer chaque échange dans un dossier unique."
        ),
        category=category,
        category_rationale=rationale
        + " Un score de risque appris pourra compléter les règles une fois l'historique consolidé.",
        effort=EffortLevel.moyen,
        target_delivery="8-10 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "financing",
                "Coût de financement évité",
                "product",
                ("overdue_amount", "dso_reduction", "cost_of_capital"),
                annualize=1,
            ),
            ValueLine(
                "losses",
                "Pertes sur créances évitées",
                "product",
                ("late60_amount", "loss_avoided"),
                annualize=1,
                family="risk",
            ),
            ValueLine(
                "followup",
                "Temps de relance économisé",
                "time",
                ("overdue_per_month", "followup_minutes", "automation"),
                "hourly_cost_mad",
                scale=1 / 60,
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Export quotidien des factures (ERP + Excel + email)",
            "Score de priorité (règles transparentes)",
            "Séquences de relance",
            "Dossier client unique (échanges, copies de factures)",
            "Tableau de bord encours",
        ],
        pilot_plan=_pilot(
            ("Consolidation des sources de factures", 3),
            ("Règles de priorité validées avec la DAF", 2),
            ("Pilote sur 20 clients", 3),
            ("Mesure DSO", 2),
        ),
        kpis=["Encours échu", "DSO", "Créances > 60 jours", "Temps de relance"],
        risk_reduction=0.6,
        data_readiness=0.85,
        compliance=0.35,
    )


def dormant_stock(env: Env, f: Finding) -> OpportunitySpec:
    s = f.signals
    category, rationale = choose_category(C.bi_data)
    assumptions = [
        AssumptionSpec(
            "dormant_value",
            "Valeur du stock dormant",
            round(s["dormant_value"]),
            "MAD",
            F,
            "Somme des valeurs des références au-delà du seuil.",
            "actuel",
            metric_key="dormant_value",
            confidence=0.95,
        ),
        AssumptionSpec(
            "reduction",
            "Part du stock dormant écoulée la première année",
            0.10,
            "ratio",
            H,
            "Déstockage, retours fournisseurs, promotions ciblées : 10 % la 1re année (prudent).",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "holding_rate",
            "Coût de détention du stock",
            bench("stock_holding_rate", env.params),
            "/an",
            H,
            "Stockage, obsolescence et immobilisation (benchmark distribution).",
            "actuel",
            min_value=0,
            max_value=0.5,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    return OpportunitySpec(
        code="opp:dormant_stock",
        title="Détection du stock dormant & recommandations de déstockage",
        summary="Alerter dès qu'une référence ralentit, proposer l'action adaptée (promotion, retour, transfert, arrêt de réassort) et suivre le cash libéré.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.moyen,
        target_delivery="8-12 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "holding",
                "Coût de détention évité",
                "product",
                ("dormant_value", "reduction", "holding_rate"),
                annualize=1,
            )
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Export stock et ventes ERP",
            "Règles de rotation par catégorie",
            "Recommandations d'action",
            "Suivi du cash libéré",
        ],
        pilot_plan=_pilot(
            ("Seuils par famille", 2),
            ("Tableau de bord rotation", 3),
            ("Plan de déstockage pilote", 4),
            ("Mesure", 1),
        ),
        kpis=["Valeur du stock > 180 j", "Rotation du stock", "Cash libéré"],
        risk_reduction=0.4,
        data_readiness=0.9,
    )


def reporting_automation(env: Env, f: Finding) -> OpportunitySpec:
    category, rationale = choose_category(C.bi_data)
    assumptions = [
        AssumptionSpec(
            "reports_per_month",
            "Reportings de direction par mois",
            1,
            "rapport/mois",
            F,
            "Rapport mensuel (documents analysés).",
            "actuel",
        ),
        AssumptionSpec(
            "people",
            "Personnes mobilisées sur la consolidation",
            2,
            "personnes",
            H,
            "Finance + contrôle de gestion (à confirmer).",
            "actuel",
            min_value=1,
        ),
        AssumptionSpec(
            "days",
            "Jours de retraitement par reporting",
            3,
            "jours",
            H,
            "Durée non mesurée dans les sources : 3 jours de retraitements Excel par clôture (à confirmer en entretien).",
            "actuel",
            min_value=0,
        ),
        AssumptionSpec("hours_per_day", "Heures par jour", 8, "h", F, "Journée standard.", "actuel"),
        AssumptionSpec(
            "automation",
            "Part des retraitements automatisée",
            0.7,
            "ratio",
            H,
            "Rapprochement ERP automatisé, contrôles de cohérence.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.faible),
    ]
    return OpportunitySpec(
        code="opp:reporting_automation",
        title="Reporting direction automatisé",
        summary="Alimenter automatiquement le reporting mensuel depuis l'ERP avec des contrôles de rapprochement, pour livrer avant l'échéance contractuelle sans retraitement manuel.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.faible,
        target_delivery="4-6 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "consolidation",
                "Temps de consolidation économisé",
                "time",
                ("reports_per_month", "people", "days", "hours_per_day", "automation"),
                "hourly_cost_mad",
            )
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Extraction ERP planifiée",
            "Modèle de données KPI",
            "Contrôles de rapprochement",
            "Tableau de bord Power BI",
        ],
        pilot_plan=_pilot(
            ("Dictionnaire des KPI", 1), ("Flux ERP → modèle", 2), ("Tableau de bord et contrôles", 2)
        ),
        kpis=["Date de publication du reporting", "Écarts reporting / ERP", "Heures de consolidation"],
        risk_reduction=0.4,
        data_readiness=0.6,
    )


def support_assistant(env: Env, f: Finding) -> OpportunitySpec:
    s = f.signals
    ds = env.ctx.dataset("tickets")
    unstructured = any(c in s.get("channels", {}) for c in ("WhatsApp", "Email"))
    category, rationale = choose_category(
        C.assistant_ia, unstructured=unstructured, fallback=C.integration_si
    )
    problems = s["missing"] + s["duplicate"] + s["routing"]
    assumptions = [
        *_volume(env, ds, "tickets", "Tickets"),
        AssumptionSpec(
            "problem_tickets",
            "Tickets avec historique manquant, doublon ou routage manuel",
            problems,
            "tickets",
            F,
            "Décompte des anomalies observées dans les tickets.",
            "actuel",
            confidence=0.9,
        ),
        AssumptionSpec(
            "triage_minutes",
            "Temps de qualification et de routage par ticket",
            10,
            "min",
            H,
            "Lecture, recherche client, affectation.",
            "actuel",
        ),
        AssumptionSpec(
            "rework_minutes",
            "Temps perdu par ticket en anomalie",
            45,
            "min",
            H,
            "Recherche d'historique, rappel client, traitement en double.",
            "actuel",
        ),
        AssumptionSpec(
            "automation",
            "Part de la qualification automatisée",
            0.6,
            "ratio",
            H,
            "Résumé, classification et routage proposés par l'assistant.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "rework_reduction",
            "Réduction des anomalies (dossier unique)",
            0.7,
            "ratio",
            H,
            "Historique centralisé, dédoublonnage.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    assumptions.append(_per_period(assumptions))
    ai = category in AI_CATEGORIES
    return OpportunitySpec(
        code="opp:support_assistant",
        title="Assistant SAV omnicanal" if ai else "Outil de ticketing unique",
        summary=f"Centraliser les {len(s['channels'])} canaux dans un outil de tickets unique ; l'assistant résume chaque demande, retrouve l'historique, propose la catégorie et l'affectation.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.moyen,
        target_delivery="8-10 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "triage",
                "Temps de qualification économisé",
                "time",
                ("records", "per_period", "triage_minutes", "automation"),
                "hourly_cost_mad",
                scale=1 / 60,
            ),
            ValueLine(
                "rework",
                "Retraitements évités",
                "time",
                ("problem_tickets", "per_period", "rework_minutes", "rework_reduction"),
                "hourly_cost_mad",
                scale=1 / 60,
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Connecteurs email / WhatsApp Business / portail / téléphonie",
            "Outil de tickets unique",
            "Assistant : résumé, classification, routage",
            "Historique client consolidé",
            "Alertes SLA",
        ],
        pilot_plan=_pilot(
            ("Choix de l'outil et connecteurs", 3),
            ("Règles de routage et assistant", 3),
            ("Pilote équipe SAV", 3),
            ("Mesure", 1),
        ),
        kpis=[
            "Délai de résolution médian et p90",
            "Tickets sans historique",
            "Doublons",
            "Satisfaction client",
        ],
        risk_reduction=0.5,
        data_readiness=0.8,
        compliance=0.4,
    )


def sla_radar(env: Env, f: Finding) -> OpportunitySpec:
    s = f.signals
    category, rationale = choose_category(C.automatisation)
    contracts_total = sum(c.annual_amount or 0 for c in env.ex.contracts)
    breach = s.get("breach_rate")
    assumptions = [
        AssumptionSpec(
            "exposure",
            "Exposition maximale aux pénalités",
            round(s.get("exposure") or 0),
            "MAD/an",
            CALC,
            "Σ montant annuel × taux de pénalité des contrats (pénalité appliquée chaque mois).",
            "actuel",
            metric_key="penalty_exposure",
            confidence=0.8,
        ),
        AssumptionSpec(
            "breach_probability",
            "Probabilité de déclenchement des pénalités",
            round(breach, 4) if breach else 0.5,
            "ratio",
            CALC if breach else H,
            "Taux de dépassement SLA observé."
            if breach
            else "Aucun suivi SLA par dossier : 50 % (hypothèse).",
            "actuel",
            metric_key="breach_rate" if breach else None,
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "penalty_reduction",
            "Pénalités évitées grâce aux alertes",
            0.5,
            "ratio",
            H,
            "Alerte avant échéance et réaffectation.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "contracts_value",
            "Chiffre d'affaires sous contrat avec SLA",
            round(contracts_total),
            "MAD/an",
            F,
            f"Somme des montants annuels de {len(env.ex.contracts)} contrats.",
            "actuel",
            confidence=0.95,
        ),
        AssumptionSpec(
            "churn_reduction",
            "Risque de non-renouvellement évité",
            0.02,
            "ratio",
            H,
            "Réduction du risque de perte des contrats (hypothèse prudente).",
            "cible",
            min_value=0,
            max_value=0.2,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    return OpportunitySpec(
        code="opp:sla_radar",
        title="Radar SLA & pénalités",
        summary="Calculer l'échéance contractuelle de chaque dossier dès sa création, alerter avant le dépassement et chiffrer en continu l'exposition aux pénalités.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.moyen,
        target_delivery="6-10 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "penalties",
                "Pénalités évitées",
                "product",
                ("exposure", "breach_probability", "penalty_reduction"),
                annualize=1,
                family="risk",
            ),
            ValueLine(
                "retention",
                "Chiffre d'affaires contractuel sécurisé",
                "product",
                ("contracts_value", "churn_reduction"),
                annualize=1,
                family="revenue",
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Référentiel des SLA par contrat",
            "Horodatage des dossiers",
            "Moteur d'alertes (J-1, H-4)",
            "Tableau de bord des pénalités",
        ],
        pilot_plan=_pilot(
            ("Référentiel SLA", 2), ("Alertes et escalade", 3), ("Tableau de bord", 2), ("Mesure", 1)
        ),
        kpis=["Taux de respect des SLA", "Pénalités payées", "Dossiers en alerte"],
        risk_reduction=0.8,
        data_readiness=0.75,
    )


def planning_optimiser(env: Env, f: Finding) -> OpportunitySpec:
    ds = next(d for d in env.ctx.datasets if d.has("planning_source"))
    sla = next((x for x in env.ex.contracts if x.penalty_pct), None)
    category, rationale = choose_category(C.prediction_optimisation, optimisation=True)
    sla_finding_breach = None
    br = [r for r in ds.values("sla_breached")] if ds.has("sla_breached") else []
    if br:
        sla_finding_breach = sum(1 for v in br if v.strip().lower() in ("yes", "oui", "true", "1")) / len(br)
    exposure = sum((c.annual_amount or 0) * (c.penalty_pct or 0) / 100 for c in env.ex.contracts)
    assumptions = [
        *_volume(env, ds, "interventions", "Interventions"),
        AssumptionSpec(
            "planning_minutes",
            "Temps de planification et de coordination par intervention",
            20,
            "min",
            H,
            "Appels et messages WhatsApp de confirmation (à mesurer en entretien).",
            "actuel",
        ),
        AssumptionSpec(
            "automation",
            "Part de la planification automatisée",
            0.6,
            "ratio",
            H,
            "Proposition automatique du planning, validation par le planificateur.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "travel_minutes",
            "Temps technicien gagné par intervention (tournées optimisées)",
            15,
            "min",
            H,
            "Regroupement géographique des sites.",
            "cible",
        ),
        AssumptionSpec(
            "tech_hourly_cost",
            "Coût horaire chargé d'un technicien",
            120,
            "MAD/h",
            H,
            "Benchmark technicien (à confirmer avec la DRH).",
            "actuel",
        ),
        AssumptionSpec(
            "exposure",
            "Exposition maximale aux pénalités",
            round(exposure),
            "MAD/an",
            CALC,
            "Σ montant annuel × pénalité des contrats.",
            "actuel",
            confidence=0.8,
        ),
        AssumptionSpec(
            "breach_rate",
            "Taux de dépassement SLA observé",
            round(sla_finding_breach or 0.3, 4),
            "ratio",
            CALC if sla_finding_breach else H,
            "Calcul sur les interventions." if sla_finding_breach else "Hypothèse.",
            "actuel",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "sla_gain",
            "Réduction des dépassements grâce au planning",
            0.3,
            "ratio",
            H,
            "Affectation selon compétences, distance et échéance.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code="opp:planning_optimiser",
        title="Agent de planification des interventions",
        summary=(
            "Proposer chaque jour un planning optimisé (compétences, sites, échéances SLA, trajets), envoyer les confirmations aux techniciens "
            "et replanifier automatiquement les urgences ; le planificateur arbitre."
        ),
        category=category,
        category_rationale=rationale
        + " Les confirmations aux techniciens sont envoyées par messages structurés, sans IA.",
        effort=EffortLevel.moyen,
        target_delivery="8-12 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "planning",
                "Temps de planification économisé",
                "time",
                ("records", "per_period", "planning_minutes", "automation"),
                "hourly_cost_mad",
                scale=1 / 60,
            ),
            ValueLine(
                "travel",
                "Temps technicien récupéré",
                "time",
                ("records", "per_period", "travel_minutes"),
                "tech_hourly_cost",
                scale=1 / 60,
            ),
            ValueLine(
                "penalties",
                "Pénalités SLA évitées",
                "product",
                ("exposure", "breach_rate", "sla_gain"),
                annualize=1,
                family="risk",
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        departments_involved=2,
        architecture=[
            "Référentiel sites, compétences, SLA",
            "Moteur d'optimisation (contraintes)",
            "Application mobile technicien",
            "Notifications et confirmations",
            "Tableau de bord charge / SLA",
        ],
        pilot_plan=_pilot(
            ("Référentiels et contraintes", 3),
            ("Moteur et règles d'arbitrage", 4),
            ("Pilote sur 2 équipes", 4),
            ("Mesure", 1),
        ),
        kpis=[
            "Interventions planifiées automatiquement",
            "Respect des SLA",
            "Temps de trajet",
            "Replanifications",
        ],
        risk_reduction=0.6,
        data_readiness=0.75 if sla else 0.6,
        compliance=0.25,
    )


def field_reports(env: Env, f: Finding) -> OpportunitySpec:
    ds = next((d for d in env.ctx.datasets if d.kind == "interventions"), None)
    category, rationale = choose_category(C.assistant_ia, unstructured=True)
    base = (
        _volume(env, ds, "interventions", "Interventions")
        if ds
        else [
            AssumptionSpec("period_months", "Période", 1, "mois", H, "Hypothèse", "actuel"),
            AssumptionSpec(
                "records", "Interventions par mois", 100, "interventions", H, "Hypothèse", "actuel"
            ),
        ]
    )
    assumptions = [
        *base,
        AssumptionSpec(
            "report_minutes",
            "Temps de rédaction d'un compte rendu",
            15,
            "min",
            H,
            "Notes, photos, signature client.",
            "actuel",
        ),
        AssumptionSpec(
            "automation",
            "Part de la rédaction assistée",
            0.5,
            "ratio",
            H,
            "Dictée vocale et photos transformées en compte rendu structuré.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "chase_share",
            "Part des interventions nécessitant une relance du bureau",
            0.3,
            "ratio",
            H,
            f"{f.signals['emails']} échanges signalent des comptes rendus manquants.",
            "actuel",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "chase_minutes",
            "Temps de relance par compte rendu manquant",
            10,
            "min",
            H,
            "Appel ou message au technicien.",
            "actuel",
        ),
        AssumptionSpec(
            "tech_hourly_cost",
            "Coût horaire chargé d'un technicien",
            120,
            "MAD/h",
            H,
            "Benchmark technicien.",
            "actuel",
        ),
        _hourly(env),
        *_costs(category, EffortLevel.faible),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code="opp:field_reports",
        title="Compte rendu terrain assisté par IA",
        summary="Le technicien dicte et photographie ; l'assistant produit un compte rendu structuré rattaché à l'intervention, validé par le client sur mobile.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.faible,
        target_delivery="6-8 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "writing",
                "Temps de rédaction économisé (techniciens)",
                "time",
                ("records", "per_period", "report_minutes", "automation"),
                "tech_hourly_cost",
                scale=1 / 60,
            ),
            ValueLine(
                "chasing",
                "Relances évitées (bureau)",
                "time",
                ("records", "per_period", "chase_share", "chase_minutes"),
                "hourly_cost_mad",
                scale=1 / 60,
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Application mobile (dictée, photos, signature)",
            "Transcription et structuration (LLM, données masquées)",
            "Rattachement à l'intervention",
            "Envoi automatique au client et à la facturation",
        ],
        pilot_plan=_pilot(
            ("Modèle de compte rendu", 1),
            ("Application et assistant", 3),
            ("Pilote 5 techniciens", 3),
            ("Mesure", 1),
        ),
        kpis=["Comptes rendus reçus le jour même", "Délai intervention → facture", "Relances du bureau"],
        risk_reduction=0.5,
        data_readiness=0.6,
        compliance=0.35,
    )


def invoicing_flow(env: Env, f: Finding) -> OpportunitySpec:
    s = f.signals
    category, rationale = choose_category(C.integration_si)
    revenue = s.get("revenue") or 0
    assumptions = [
        AssumptionSpec(
            "revenue",
            "Chiffre d'affaires annuel",
            revenue,
            "MAD/an",
            F,
            "Profil de l'entreprise.",
            "actuel",
            confidence=0.95,
        ),
        AssumptionSpec(
            "days_gained",
            "Jours de facturation gagnés",
            7,
            "jours",
            H,
            "Délai intervention → facture non mesuré dans les sources : gain de 7 jours (à mesurer).",
            "cible",
            min_value=0,
            max_value=60,
        ),
        AssumptionSpec(
            "cost_of_capital",
            "Coût du capital",
            bench("cost_of_capital", env.params),
            "/an",
            H,
            "Hypothèse à valider avec la DAF.",
            "actuel",
        ),
        AssumptionSpec(
            "invoices_per_month",
            "Factures par mois",
            s.get("invoices_per_month") or 20,
            "factures/mois",
            CALC,
            "Calcul sur les factures clients.",
            "actuel",
        ),
        AssumptionSpec(
            "invoice_minutes",
            "Temps de constitution d'une facture",
            15,
            "min",
            H,
            "Collecte des justificatifs, saisie.",
            "actuel",
        ),
        AssumptionSpec(
            "automation",
            "Part automatisée",
            0.6,
            "ratio",
            H,
            "Facture pré-remplie depuis le dossier d'intervention.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.faible),
    ]
    return OpportunitySpec(
        code="opp:invoicing_flow",
        title="Dossier d'intervention vers facturation",
        summary="Dès la clôture d'une intervention, le dossier (compte rendu, photos, signature, pièces) part en facturation avec une facture pré-remplie dans l'ERP.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.faible,
        target_delivery="6-8 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "cash",
                "Accélération de l'encaissement",
                "product",
                ("revenue", "days_gained", "cost_of_capital"),
                annualize=1,
                scale=1 / 365,
            ),
            ValueLine(
                "admin",
                "Temps de facturation économisé",
                "time",
                ("invoices_per_month", "invoice_minutes", "automation"),
                "hourly_cost_mad",
                scale=1 / 60,
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        departments_involved=2,
        architecture=[
            "Clôture d'intervention",
            "Dossier justificatif complet",
            "Facture pré-remplie ERP",
            "Envoi client et suivi",
        ],
        pilot_plan=_pilot(
            ("Règles de complétude du dossier", 2),
            ("Intégration ERP", 3),
            ("Pilote 2 contrats", 2),
            ("Mesure", 1),
        ),
        kpis=["Délai intervention → facture", "Factures hors ERP", "Litiges sur justificatifs"],
        risk_reduction=0.4,
        data_readiness=0.6,
    )


def parts_anticipation(env: Env, f: Finding) -> OpportunitySpec:
    ds = env.ctx.dataset("purchases")
    s = f.signals
    dated = period_months(ds) is not None
    category, rationale = choose_category(
        C.prediction_optimisation, prediction=dated, fallback=C.amelioration_processus
    )
    if not dated:
        rationale += " La prévision deviendra possible une fois l'historique daté des consommations collecté."
    assumptions = [
        *_volume(env, ds, "achats", "Achats"),
        AssumptionSpec(
            "extra_cost",
            "Surcoût payé sur les achats urgents (données)",
            round(s["extra_cost"]),
            "MAD",
            CALC,
            "Σ montant × premium / (100 + premium) sur les achats urgents.",
            "actuel",
            metric_key="extra_cost",
            confidence=0.85,
        ),
        AssumptionSpec(
            "avoidable",
            "Part des urgences évitables par anticipation",
            0.5,
            "ratio",
            H,
            "Consolidation des besoins et stock de sécurité.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code="opp:parts_anticipation",
        title="Prévision des besoins en pièces"
        if dated
        else "Anticipation des besoins en pièces (stock de sécurité, achats groupés)",
        summary="Consolider les besoins en pièces par famille, fixer des stocks de sécurité pour les références critiques et regrouper les commandes pour réduire les achats urgents.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.moyen,
        target_delivery="8-12 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "premium", "Surcoûts d'urgence évités", "product", ("extra_cost", "per_period", "avoidable")
            )
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Historique des consommations par famille",
            "Stocks de sécurité",
            "Consolidation hebdomadaire des besoins",
            "Accords-cadres fournisseurs",
        ],
        pilot_plan=_pilot(
            ("Analyse ABC des pièces", 2), ("Stocks de sécurité", 3), ("Commandes groupées", 3), ("Mesure", 1)
        ),
        kpis=["Part des achats urgents", "Surcoût moyen", "Ruptures de pièces"],
        risk_reduction=0.3,
        data_readiness=0.6 if not dated else 0.8,
    )


def maintenance_copilot(env: Env, f: Finding) -> OpportunitySpec:
    ds = env.ctx.dataset("maintenance")
    s = f.signals
    unstructured = s.get("unstructured", 0) > 0
    category, rationale = choose_category(C.rag, unstructured=unstructured, fallback=C.bi_data)
    assumptions = [
        *_volume(env, ds, "interventions", "Interventions de maintenance"),
        AssumptionSpec(
            "repeat_downtime",
            "Heures d'arrêt sur pannes répétitives (données)",
            s["repeat_downtime"],
            "h",
            CALC,
            "Σ arrêts sur couples machine/symptôme répétés ≥ 3 fois.",
            "actuel",
            metric_key="repeat_downtime_h",
            confidence=0.85,
        ),
        AssumptionSpec(
            "downtime_reduction",
            "Réduction des arrêts répétitifs",
            0.3,
            "ratio",
            H,
            "Diagnostic guidé par l'historique et causes capitalisées.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "downtime_cost",
            "Coût d'une heure d'arrêt",
            1_500,
            "MAD/h",
            H,
            "Marge perdue et main-d'œuvre immobilisée (à valider avec la production).",
            "actuel",
        ),
        AssumptionSpec(
            "diag_minutes",
            "Temps de diagnostic par intervention",
            30,
            "min",
            H,
            "Recherche de l'historique et des causes.",
            "actuel",
        ),
        AssumptionSpec(
            "automation",
            "Part du diagnostic accélérée",
            0.3,
            "ratio",
            H,
            "Recherche documentaire assistée.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "tech_hourly_cost",
            "Coût horaire chargé d'un technicien",
            120,
            "MAD/h",
            H,
            "Benchmark technicien.",
            "actuel",
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code="opp:maintenance_copilot",
        title="Copilote maintenance & diagnostic",
        summary="Structurer les comptes rendus et interroger l'historique des pannes (causes, pièces, solutions) pendant le diagnostic, avec citations des interventions passées.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.moyen,
        target_delivery="8-12 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "downtime",
                "Arrêts machine évités",
                "product",
                ("repeat_downtime", "per_period", "downtime_reduction", "downtime_cost"),
            ),
            ValueLine(
                "diagnosis",
                "Temps de diagnostic économisé",
                "time",
                ("records", "per_period", "diag_minutes", "automation"),
                "tech_hourly_cost",
                scale=1 / 60,
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Compte rendu structuré (formulaire mobile)",
            "Base de connaissances des pannes",
            "Recherche hybride + citations",
            "Assistant de diagnostic",
        ],
        pilot_plan=_pilot(
            ("Numérisation de l'historique", 3),
            ("Formulaire structuré", 2),
            ("Assistant sur 2 machines", 4),
            ("Mesure", 1),
        ),
        kpis=["Pannes sans cause identifiée", "Heures d'arrêt répétitives", "MTTR"],
        risk_reduction=0.5,
        data_readiness=0.65,
        compliance=0.15,
    )


def quality_analysis(env: Env, f: Finding) -> OpportunitySpec:
    ds = env.ctx.dataset("non_conformities")
    s = f.signals
    unstructured = any(re.search(r"pdf|email", k, re.I) for k in s.get("sources", {}))
    category, rationale = choose_category(C.assistant_ia, unstructured=unstructured, fallback=C.bi_data)
    assumptions = [
        *_volume(env, ds, "non-conformités", "Non-conformités"),
        AssumptionSpec(
            "repeats",
            "Non-conformités répétées (données)",
            s["repeat"],
            "NC",
            F,
            "Décompte des récurrences sous 90 jours.",
            "actuel",
            confidence=0.9,
        ),
        AssumptionSpec(
            "cost_per_nc",
            "Coût moyen d'une non-conformité",
            8_000,
            "MAD",
            H,
            "Rebut, reprise, gestion de la réclamation (à valider avec la qualité).",
            "actuel",
        ),
        AssumptionSpec(
            "reduction",
            "Réduction des récurrences",
            0.3,
            "ratio",
            H,
            "Causes racines capitalisées et actions correctives suivies.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "analysis_minutes",
            "Temps d'analyse par non-conformité",
            60,
            "min",
            H,
            "Collecte des éléments (PDF, emails, Excel).",
            "actuel",
        ),
        AssumptionSpec(
            "automation",
            "Part de l'analyse assistée",
            0.5,
            "ratio",
            H,
            "Extraction et regroupement automatiques.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code="opp:quality_analysis",
        title="Analyse IA des non-conformités"
        if category in AI_CATEGORIES
        else "Tableau de bord qualité unifié",
        summary="Extraire automatiquement causes et actions des fiches PDF, emails et fichiers Excel, regrouper les non-conformités similaires et suivre les actions correctives.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.moyen,
        target_delivery="8-10 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "repeats",
                "Récurrences évitées",
                "product",
                ("repeats", "per_period", "reduction", "cost_per_nc"),
            ),
            ValueLine(
                "analysis",
                "Temps d'analyse économisé",
                "time",
                ("records", "per_period", "analysis_minutes", "automation"),
                "hourly_cost_mad",
                scale=1 / 60,
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Collecte PDF / emails / Excel",
            "Extraction structurée (LLM, données masquées)",
            "Regroupement des NC similaires",
            "Suivi des actions correctives",
        ],
        pilot_plan=_pilot(
            ("Référentiel des causes", 2),
            ("Extraction et regroupement", 3),
            ("Pilote sur une famille de défauts", 3),
            ("Mesure", 1),
        ),
        kpis=["Taux de récurrence à 90 jours", "NC sans cause racine", "Délai de clôture des actions"],
        risk_reduction=0.6,
        data_readiness=0.7,
        compliance=0.2,
    )


def scheduling_assistant(env: Env, f: Finding) -> OpportunitySpec:
    ds = env.ctx.dataset("production")
    s = f.signals
    category, rationale = choose_category(C.prediction_optimisation, optimisation=True)
    replans = sum(r or 0 for r in ds.numbers("replans")) if ds.has("replans") else 0
    assumptions = [
        *_volume(env, ds, "ordres", "Ordres de fabrication"),
        AssumptionSpec(
            "excess_hours",
            "Heures au-delà du prévu (données)",
            round(s["excess_hours"], 1),
            "h",
            CALC,
            "Σ heures réelles − Σ heures prévues.",
            "actuel",
            metric_key="excess_hours",
            confidence=0.9,
        ),
        AssumptionSpec(
            "excess_reduction",
            "Réduction des dépassements",
            0.25,
            "ratio",
            H,
            "Séquencement optimisé, temps standards fiabilisés.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "hour_cost",
            "Coût d'une heure de production",
            450,
            "MAD/h",
            H,
            "Machine + équipe (à valider avec le contrôle de gestion).",
            "actuel",
        ),
        AssumptionSpec(
            "replans",
            "Replanifications (données)",
            replans,
            "replanifications",
            F,
            "Somme de la colonne replans.",
            "actuel",
        ),
        AssumptionSpec(
            "replan_minutes",
            "Temps de replanification",
            15,
            "min",
            H,
            "Mise à jour du fichier partagé et communication.",
            "actuel",
        ),
        AssumptionSpec(
            "automation",
            "Part des replanifications automatisée",
            0.6,
            "ratio",
            H,
            "Recalcul automatique du planning.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.eleve),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code="opp:scheduling_assistant",
        title="Assistant d'ordonnancement",
        summary="Calculer un planning de production faisable (capacités, changements de format, priorités clients) et le recalculer en cas d'aléa, au lieu d'ajuster des fichiers partagés.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.eleve,
        target_delivery="12-16 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "excess",
                "Heures de production récupérées",
                "product",
                ("excess_hours", "per_period", "excess_reduction", "hour_cost"),
            ),
            ValueLine(
                "replanning",
                "Temps de replanification économisé",
                "time",
                ("replans", "per_period", "replan_minutes", "automation"),
                "hourly_cost_mad",
                scale=1 / 60,
            ),
        ],
        assumptions=assumptions,
        department=f.department,
        departments_involved=3,
        architecture=[
            "Référentiel gammes et capacités",
            "Carnet de commandes",
            "Moteur d'ordonnancement sous contraintes",
            "Écran de pilotage atelier",
        ],
        pilot_plan=_pilot(
            ("Fiabilisation des temps standards", 4),
            ("Moteur et règles", 5),
            ("Pilote ligne 1", 5),
            ("Mesure", 2),
        ),
        kpis=["Replanifications par ordre", "Écart temps réel / prévu", "Taux de service"],
        risk_reduction=0.4,
        data_readiness=0.7,
        compliance=0.1,
    )


def material_drift(env: Env, f: Finding) -> OpportunitySpec:
    s = f.signals
    category, rationale = choose_category(C.bi_data)
    revenue = env.ctx.mission.organization.revenue_mad or 0
    assumptions = [
        AssumptionSpec(
            "revenue",
            "Chiffre d'affaires annuel",
            revenue,
            "MAD/an",
            F,
            "Profil de l'entreprise.",
            "actuel",
            confidence=0.95,
        ),
        AssumptionSpec(
            "material_share",
            "Part de la matière dans le chiffre d'affaires",
            0.45,
            "ratio",
            H,
            "Carton et encres : 40-50 % du CA dans l'emballage (benchmark à valider).",
            "actuel",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "excess_points",
            "Points de rebut au-dessus de la cible",
            round(s["waste_mean"] - s["waste_target"], 2) / 100,
            "ratio",
            CALC,
            f"Rebut moyen {n1(s['waste_mean'])} % − cible {n1(s['waste_target'])} % (cible = hypothèse).",
            "actuel",
            metric_key="waste_excess_pts",
        ),
        AssumptionSpec(
            "recovery",
            "Part de l'écart récupérée",
            0.2,
            "ratio",
            H,
            "Détection précoce des dérives et actions par ligne.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    return OpportunitySpec(
        code="opp:material_drift",
        title="Détection des dérives de consommation matière",
        summary="Comparer en continu consommation théorique et réelle par ordre, ligne et format, alerter dès la dérive et documenter la cause au lieu d'une analyse en fin de semaine.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.moyen,
        target_delivery="8-12 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "material",
                "Matière économisée",
                "product",
                ("revenue", "material_share", "excess_points", "recovery"),
                annualize=1,
            )
        ],
        assumptions=assumptions,
        department=f.department,
        architecture=[
            "Nomenclatures et consommations théoriques",
            "Remontée des consommations réelles",
            "Cartes de contrôle par ligne",
            "Alertes et saisie des causes",
        ],
        pilot_plan=_pilot(
            ("Consommations théoriques", 3),
            ("Cartes de contrôle", 3),
            ("Pilote ligne la plus dérivante", 3),
            ("Mesure", 1),
        ),
        kpis=["Taux de rebut", "Écart théorique / réel", "Dérives détectées sous 24 h"],
        risk_reduction=0.3,
        data_readiness=0.65,
        compliance=0.1,
    )


def demand_forecast(env: Env, f: Finding) -> OpportunitySpec:
    ds = env.ctx.dataset("production")
    category, rationale = choose_category(C.prediction_optimisation, prediction=True)
    planned, actual = ds.numbers("planned_hours"), ds.numbers("actual_hours")
    excess = sum(a or 0 for a in actual) - sum(p or 0 for p in planned)
    assumptions = [
        *_volume(env, ds, "ordres", "Ordres de fabrication"),
        AssumptionSpec(
            "excess_hours",
            "Heures au-delà du prévu (données)",
            round(excess, 1),
            "h",
            CALC,
            "Σ réel − Σ prévu.",
            "actuel",
            confidence=0.9,
        ),
        AssumptionSpec(
            "forecast_share",
            "Part des dérives liée au manque de visibilité commerciale",
            0.3,
            "ratio",
            H,
            "Hypothèse à confirmer : aucune donnée de prévision dans les sources.",
            "actuel",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "reduction",
            "Réduction obtenue avec une prévision partagée",
            0.3,
            "ratio",
            H,
            "Prévision hebdomadaire co-construite ventes / production.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        AssumptionSpec(
            "hour_cost", "Coût d'une heure de production", 450, "MAD/h", H, "Machine + équipe.", "actuel"
        ),
        _hourly(env),
        *_costs(category, EffortLevel.moyen),
    ]
    assumptions.append(_per_period(assumptions))
    return OpportunitySpec(
        code="opp:demand_forecast",
        title="Prévision demande & charge",
        summary="Mettre en place un processus de prévision hebdomadaire ventes / production, puis un modèle de prévision dès que l'historique des commandes est disponible.",
        category=category,
        category_rationale=rationale
        + " Prérequis : collecter l'historique des commandes et des prévisions, absent des sources.",
        effort=EffortLevel.moyen,
        target_delivery="10-14 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "excess",
                "Heures de production récupérées",
                "product",
                ("excess_hours", "per_period", "forecast_share", "reduction", "hour_cost"),
            )
        ],
        assumptions=assumptions,
        department=f.department,
        departments_involved=2,
        architecture=[
            "Historique des commandes (à collecter)",
            "Rituel S&OP hebdomadaire",
            "Modèle de prévision",
            "Partage avec l'ordonnancement",
        ],
        pilot_plan=_pilot(
            ("Collecte de l'historique", 4), ("Rituel S&OP", 2), ("Premier modèle", 4), ("Mesure", 2)
        ),
        kpis=["Biais et erreur de prévision", "Replanifications", "Taux de service"],
        risk_reduction=0.3,
        data_readiness=0.25,
        compliance=0.1,
    )


def procedures_refresh(env: Env, f: Finding) -> OpportunitySpec:
    category, rationale = choose_category(C.amelioration_processus)
    headcount = sum(d.headcount for d in env.ex.org.departments.values()) or 50
    assumptions = [
        AssumptionSpec(
            "employees",
            "Collaborateurs concernés",
            headcount,
            "personnes",
            F,
            "Effectif analysé.",
            "actuel",
            confidence=0.95,
        ),
        AssumptionSpec(
            "search_hours",
            "Temps mensuel perdu à chercher qui fait quoi",
            0.5,
            "h",
            H,
            "Exceptions traitées par email, propriétaires non définis.",
            "actuel",
        ),
        AssumptionSpec(
            "reduction",
            "Réduction de ce temps",
            0.3,
            "ratio",
            H,
            "Procédures à jour, RACI et circuits d'exception définis.",
            "cible",
            min_value=0,
            max_value=1,
        ),
        _hourly(env),
        *_costs(category, EffortLevel.faible),
    ]
    return OpportunitySpec(
        code="opp:procedures_refresh",
        title="Mise à jour des procédures et des responsabilités (RACI)",
        summary="Désigner un propriétaire par étape, revoir les procédures obsolètes et formaliser le circuit des exceptions — prérequis des automatisations.",
        category=category,
        category_rationale=rationale,
        effort=EffortLevel.faible,
        target_delivery="4-6 sem.",
        pain_codes=[f.code],
        lines=[
            ValueLine(
                "search",
                "Temps de coordination économisé",
                "time",
                ("employees", "search_hours", "reduction"),
                "hourly_cost_mad",
            )
        ],
        assumptions=assumptions,
        department=None,
        departments_involved=4,
        architecture=["RACI par procédure", "Référentiel documentaire versionné", "Revue annuelle"],
        pilot_plan=_pilot(("Ateliers RACI", 2), ("Mise à jour des procédures", 2), ("Diffusion", 1)),
        kpis=["Procédures à jour", "Étapes sans propriétaire"],
        risk_reduction=0.5,
        data_readiness=0.8,
        compliance=0.1,
    )


TEMPLATES: list[tuple[str, Callable[[Env, Finding], OpportunitySpec]]] = [
    ("manual_entry:quotes", quote_copilot),
    ("manual_entry:", data_entry_automation),
    ("commercial:quotes_conversion", quote_followup),
    ("finance:receivables", receivables_priority),
    ("inventory:dormant_stock", dormant_stock),
    ("reporting:manual", reporting_automation),
    ("support:dispersion", support_assistant),
    ("sla:", sla_radar),
    ("planning:manual", planning_optimiser),
    ("operations:field_reports", field_reports),
    ("finance:invoicing_delay", invoicing_flow),
    ("procurement:urgent", parts_anticipation),
    ("maintenance:knowledge", maintenance_copilot),
    ("quality:recurrence", quality_analysis),
    ("production:instability", scheduling_assistant),
    ("production:material_waste", material_drift),
    ("sales:forecast_gap", demand_forecast),
    ("governance:procedures", procedures_refresh),
]


def generate(env: Env, findings: list[Finding]) -> list[OpportunitySpec]:
    specs: dict[str, OpportunitySpec] = {}
    for f in findings:
        template = next((fn for prefix, fn in TEMPLATES if f.code.startswith(prefix)), None)
        if template is None:
            continue
        spec = template(env, f)
        if spec.code in specs:  # e.g. two SLA findings feed the same radar
            specs[spec.code].pain_codes.extend(
                c for c in spec.pain_codes if c not in specs[spec.code].pain_codes
            )
            continue
        if f.is_hypothesis:
            spec.data_readiness = min(spec.data_readiness, 0.3)
        spec.target_delivery = spec.target_delivery or DELIVERY[EffortLevel(spec.effort)]
        specs[spec.code] = spec
    return list(specs.values())


__all__ = ["AssumptionSpec", "OpportunitySpec", "choose_category", "extract_period", "generate"]
