"""Column semantics: map arbitrary column names (FR/EN) to business concepts.

The engine reasons on concepts ("amount", "days_overdue", "manual_flag"...), never on file names,
so the same detectors work for a distributor, a facility-management firm or a factory.
Concepts are tried in order and each column is claimed once, most specific first.
"""

from __future__ import annotations

import re

from app.ingestion.classifier import normalize

CONCEPTS: list[tuple[str, str]] = [
    (
        "days_since_movement",
        r"days?_since_last_(sale|movement|move|use)|jours?_sans_mouvement|anciennete_stock",
    ),
    ("days_overdue", r"days?_overdue|overdue_days|jours?_(de_)?retard|retard_jours"),
    ("sla_breached", r"sla_breach|breach|hors_sla|depassement_sla"),
    ("sla_hours", r"^sla(_hours|_h)?$|delai_contractuel|sla_heures"),
    ("resolution_hours", r"(actual_)?resolution_hours|delai_resolution|temps_resolution"),
    ("planned_hours", r"planned_hours|heures_prevues|temps_prevu"),
    ("actual_hours", r"actual_hours|heures_reelles|temps_reel"),
    ("root_cause_known", r"root_cause_known|cause_connue"),
    ("root_cause", r"root_cause|cause_racine|^cause$"),
    ("repeat_flag", r"repeat|recurren|repetition|recidive"),
    ("manual_flag", r"manual|manuel|ressaisie|reentry|re_entry"),
    ("urgent_flag", r"urgent"),
    ("price_premium_pct", r"premium|surcout"),
    ("waste_pct", r"waste|rebut|scrap|perte_matiere"),
    ("replans", r"replan|replanif|modifications_planning"),
    ("downtime_hours", r"downtime|arret|indisponibilite"),
    ("prep_minutes", r"prep(aration)?_min|temps_preparation|duree_min"),
    ("template", r"template|modele|gabarit"),
    ("stock_value", r"stock_value|valeur_stock|inventory_value"),
    ("unit_cost", r"unit_cost|cout_unitaire|prix_unitaire|unit_price"),
    ("qty", r"^qty|quantite|qty_on_hand|stock_qty"),
    ("margin_pct", r"margin|marge"),
    ("amount", r"amount|montant|total_ttc|total_ht|^value$|valeur"),
    ("report_format", r"report_format|format_rapport|format_cr"),
    ("channel", r"channel|canal"),
    ("planning_source", r"planning_source|source_planning|outil_planification"),
    ("source_system", r"^source$|source_system|systeme_source|^systeme$|^origine$"),
    ("status", r"^status$|^statut$|^etat$"),
    ("priority", r"priority|priorite|criticite"),
    ("issue", r"observed_issue|^issue$|probleme|anomalie|symptom"),
    ("nc_type", r"^type$|nature"),
    ("department", r"department|departement|^service$|^direction$"),
    ("role", r"^role$|^fonction$|^poste$"),
    ("tool", r"primary_tool|outil|^tool$"),
    ("seniority_years", r"seniority|anciennete"),
    ("manager", r"manager|responsable_id"),
    ("segment", r"segment"),
    ("line", r"^line$|^ligne$"),
    ("machine", r"machine|equipement|equipment"),
    ("site", r"site"),
    ("customer", r"customer|client"),
    ("date", r"date"),
    ("category", r"category|categorie|famille"),
    ("item", r"^item$|article|^reference$|^sku$|produit"),
    ("person_name", r"^name$|^nom$|nom_complet"),
    ("record_id", r"(^|_)id$|^id_|_no$|^numero|^ref$|work_order|^po$|^sku$"),
]

_COMPILED = [(c, re.compile(p)) for c, p in CONCEPTS]


def column_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", normalize(name)).strip("_")


def map_columns(columns: list[str]) -> dict[str, str]:
    """Return {concept: column name}. Each column is claimed by at most one concept."""
    keys = {col: column_key(col) for col in columns}
    mapping: dict[str, str] = {}
    claimed: set[str] = set()
    for concept, pattern in _COMPILED:
        for col in columns:
            if col in claimed:
                continue
            if pattern.search(keys[col]):
                mapping[concept] = col
                claimed.add(col)
                break
    return mapping


# Dataset kinds, recognised from the concepts they carry (all listed concepts are required).
DATASET_KINDS: list[tuple[str, str, list[str]]] = [
    ("quotes", "Devis", ["prep_minutes", "manual_flag"]),
    ("quotes", "Devis", ["template", "amount"]),
    ("receivables", "Factures clients", ["amount", "days_overdue"]),
    ("inventory", "Stock", ["days_since_movement", "stock_value"]),
    ("inventory", "Stock", ["days_since_movement", "qty"]),
    ("interventions", "Interventions", ["sla_hours", "resolution_hours", "planning_source"]),
    ("interventions", "Interventions", ["sla_breached", "resolution_hours"]),
    ("tickets", "Tickets support", ["channel", "resolution_hours"]),
    ("purchases", "Achats", ["urgent_flag", "amount"]),
    ("maintenance", "Interventions de maintenance", ["machine", "downtime_hours"]),
    ("non_conformities", "Non-conformités", ["root_cause", "repeat_flag"]),
    ("production", "Ordres de fabrication", ["planned_hours", "actual_hours"]),
    ("employees", "Effectifs", ["department", "role"]),
    ("org_chart", "Organigramme", ["department", "manager"]),
]


def dataset_kind(columns: list[str]) -> tuple[str, str] | None:
    concepts = map_columns(columns)
    for kind, label, required in DATASET_KINDS:
        if all(c in concepts for c in required):
            return kind, label
    return None


# Canonical tools and how they are named in the wild.
TOOLS: list[tuple[str, str, str]] = [
    ("Excel", "tableur", r"\bexcel\b|tableur|xlsx|fichier excel|fichiers? partages?"),
    ("ERP", "erp", r"\berp\b|sage|odoo|sap\b"),
    ("Email", "messagerie", r"\bemail\b|e-mail|\bmail\b|courriel|outlook"),
    ("WhatsApp", "messagerie instantanée", r"whatsapp"),
    ("Téléphone", "téléphone", r"\bphone\b|telephone|appel"),
    ("Portail", "portail", r"\bportal\b|portail"),
    ("Power BI", "bi", r"power ?bi|tableau de bord bi"),
    ("Teams", "collaboration", r"\bteams\b"),
    ("PDF", "document", r"\bpdf\b"),
    ("Formulaire papier", "papier", r"paper|papier"),
    ("Texte libre", "texte libre", r"free text|texte libre"),
    ("Microsoft 365", "bureautique", r"microsoft 365|office 365|m365"),
]
_TOOL_RE = [(name, cat, re.compile(p)) for name, cat, p in TOOLS]


def canonical_tool(value: str) -> tuple[str, str] | None:
    v = normalize(value)
    for name, category, pattern in _TOOL_RE:
        if pattern.search(v):
            return name, category
    return None


def tools_in_text(text: str) -> list[str]:
    v = normalize(text)
    return [name for name, _, pattern in _TOOL_RE if pattern.search(v)]
