"""Document classification (spec §5.2): transparent keyword rules, optionally refined by an LLM."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from app.domain.enums import DocumentCategory as C


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(ch for ch in text if not unicodedata.combining(ch))


# Weighted vocabulary per category. Column names and file names count more than body text.
VOCABULARY: dict[C, list[str]] = {
    C.finance: [
        "facture",
        "invoice",
        "encaissement",
        "impaye",
        "overdue",
        "relance",
        "tresorerie",
        "marge",
        "margin",
        "cloture",
        "comptab",
        "paiement",
        "creance",
        "days_overdue",
        "amount_mad",
        "budget",
        "montant",
        "provisionn",
    ],
    C.ventes: [
        "devis",
        "quote",
        "commercial",
        "vente",
        "pipeline",
        "won",
        "lost",
        "prospect",
        "commande client",
        "catalogue",
        "prevision commerciale",
        "segment",
    ],
    C.achats: [
        "achat",
        "purchase",
        "fournisseur",
        "supplier",
        "po_id",
        "bon de commande",
        "urgent_purchase",
        "price_premium",
        "approvisionnement",
    ],
    C.operations: [
        "intervention",
        "planning",
        "planification",
        "production",
        "work_order",
        "ordonnancement",
        "stock",
        "inventory",
        "sku",
        "logistique",
        "site_id",
        "replans",
        "planned_hours",
        "terrain",
        "technicien",
        "delai contractuel",
        "dossiers",
        "reprendre",
    ],
    C.rh: [
        "employee",
        "salarie",
        "collaborateur",
        "effectif",
        "seniority",
        "recrutement",
        "org_chart",
        "organigramme",
        "manager_employee_id",
        "role",
        "department",
    ],
    C.contrats: [
        "contrat",
        "contract",
        "engagement",
        "penalite",
        "duree",
        "clause",
        "avenant",
        "montant annuel",
        "resiliation",
    ],
    C.procedures: ["procedure", "processus", "etapes", "mode operatoire", "points de vigilance", "objectif"],
    C.qualite: [
        "non-conformite",
        "non_conformit",
        "nc_id",
        "qualite",
        "defaut",
        "defect",
        "root_cause",
        "repeat_within",
        "reclamation qualite",
        "audit qualite",
    ],
    C.maintenance: [
        "maintenance",
        "panne",
        "machine",
        "downtime",
        "symptom",
        "preventive",
        "curative",
        "report_format",
        "mnt-",
    ],
    C.support: [
        "ticket",
        "sav",
        "support",
        "resolution_hours",
        "channel",
        "incident",
        "whatsapp",
        "observed_issue",
        "helpdesk",
    ],
    C.reporting: [
        "rapport mensuel",
        "reporting",
        "kpi",
        "tableau de bord",
        "synthese",
        "dashboard",
        "monthly_report",
        "indicateur",
        "chiffre",
    ],
    C.it_securite: ["securite", "mot de passe", "acces", "sauvegarde", "rgpd", "cyber", "serveur", "licence"],
    # Company presentations, profiles and other general documents.
    C.autre: [
        "presentation",
        "objectifs de la direction",
        "systemes existants",
        "ca annuel",
        "profil",
        "secteur",
    ],
}

_EMAIL_ADDR = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

_WEIGHTS = {"filename": 3.0, "columns": 2.5, "title": 2.0, "text": 1.0}


@dataclass
class Classification:
    category: C
    confidence: float
    method: str
    scores: dict[str, float]


def _count(haystack: str, needle: str) -> int:
    return len(re.findall(re.escape(needle), haystack))


def classify(filename: str, title: str | None, text: str, columns: list[str] | None = None) -> Classification:
    fields = {
        "filename": normalize(filename.replace("_", " ") + " " + filename),
        "columns": normalize(" ".join(columns or [])),
        "title": normalize(title or ""),
        # Addresses ("collaborateur12@…") say nothing about the topic and would bias towards HR.
        "text": normalize(_EMAIL_ADDR.sub(" ", text[:20_000])),
    }
    scores: dict[str, float] = {}
    for category, words in VOCABULARY.items():
        total = 0.0
        for name, haystack in fields.items():
            if not haystack:
                continue
            hits = sum(min(_count(haystack, normalize(w)), 5) for w in words)
            total += _WEIGHTS[name] * hits
        if total:
            scores[category.value] = round(total, 2)
    if not scores:
        return Classification(C.autre, 0.3, "regles", {})
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best, best_score = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
    # Confidence grows with the margin over the runner-up and with the absolute evidence.
    margin = (best_score - runner_up) / best_score
    confidence = min(0.97, 0.45 + 0.35 * margin + min(best_score, 30) / 100)
    return Classification(C(best), round(confidence, 2), "regles", scores)
