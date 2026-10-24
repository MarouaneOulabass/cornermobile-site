"""Markdown rendering of the eval results (docs/evals/report.md)."""

from __future__ import annotations

from datetime import UTC, datetime

LABELS = {
    "recall": "Recall des irritants attendus",
    "precision_supported": "Précision (irritants étayés par une preuve vérifiée ou signalés en hypothèse)",
    "evidence_fidelity": "Fidélité des preuves (citation retrouvée telle quelle dans le fichier d'origine)",
    "evidence_relevance": "Pertinence des preuves (la preuve parle du constat qu'elle étaye)",
    "anchor_accuracy": "Exactitude des métriques (recalcul indépendant depuis les CSV)",
    "roi_accuracy": "Exactitude des business cases (recalcul indépendant des formules ROI)",
    "unsupported_rate": "Éléments sans preuve ni statut d'hypothèse",
    "untraceable_rate": "Chiffres non traçables dans les textes générés",
    "deterministic": "Déterminisme (ré-import + ré-analyse ⇒ classement identique)",
    "kendall_tau_min": "Stabilité du classement (τ de Kendall minimal, coefficients ±20 %)",
    "synthesis": "Qualité de la synthèse dirigeant (grille de contrôle)",
    "answer_key_isolated": "Corrigé du kit jamais ingéré",
    "errors": "Analyses sans erreur",
}


def _fmt(value) -> str:
    if isinstance(value, bool):
        return "oui" if value else "non"
    if isinstance(value, float):
        return f"{value:.3f}".rstrip("0").rstrip(".") if value % 1 else f"{value:.0f}"
    if isinstance(value, list):
        return "aucune" if not value else f"{len(value)} erreur(s)"
    return "—" if value is None else str(value)


def _mad(value) -> str:
    if value is None:
        return "—"
    return f"{value / 1000:,.0f} k".replace(",", " ")


def _target(key: str, target) -> str:
    if target is None:
        return "—"
    if isinstance(target, bool):
        return _fmt(target)
    return ("≤ " if key.endswith("_rate") else "≥ ") + _fmt(target)


def render_markdown(results: dict) -> str:
    s = results["summary"]
    thresholds = results["thresholds"]
    out = [
        "# Évaluation AuditFlow sur le jeu de démonstration",
        "",
        f"_Généré le {datetime.now(UTC):%Y-%m-%d %H:%M} UTC par `python -m evals` (backend/evals)._",
        "",
        "Le moteur analyse chaque entreprise exactement comme en production (import du dossier, analyse "
        "déterministe, aucun LLM). Le corrigé `ground_truth.json` n'est lu que par le module d'évaluation, "
        "après coup. Les mesures suivent le §14 du cahier des charges.",
        "",
        "## Synthèse",
        "",
        "| Mesure | Résultat | Seuil | |",
        "|---|---|---|---|",
    ]
    for key, ok in s["passed"].items():
        value = s.get(key)
        out.append(
            f"| {LABELS.get(key, key)} | {_fmt(value)} | {_target(key, thresholds.get(key))} | {'✅' if ok else '❌'} |"
        )
    out += [
        "",
        f"Indicateurs complémentaires : recall direct (hors hypothèses) {_fmt(s['recall_direct'])}, "
        f"précision stricte vs corrigé {_fmt(s['precision_strict'])}, top 3 conservé sous perturbation "
        f"{_fmt(s['top3_kept'])}, ratio médian valeur moteur / valeur de référence {_fmt(s['value_median_ratio'])}.",
        "",
        "La précision stricte compte comme faux positif tout irritant absent du corrigé. Elle est basse par "
        "construction : le moteur remonte aussi des constats documentés que le corrigé ne liste pas "
        "(créances, procédures, SLA…). Ils sont listés plus bas avec leurs sources pour revue humaine.",
        "",
    ]
    for r in results["companies"]:
        out += _company(r)
    out += [
        "## Méthode",
        "",
        "- **Recall / précision** : appariement lexical (racines de mots, domaine) entre chaque irritant planté "
        "et les irritants produits, affectation un-à-un ; les scores d'appariement sont publiés ci-dessus.",
        "- **Fidélité des preuves** : chaque preuve liée est relue dans le fichier d'origine, indépendamment de "
        "l'ingestion — lignes de texte identiques, cellules CSV identiques (ligne, colonne, valeur), colonnes et "
        "numéros de ligne existants.",
        "- **Pertinence** : une preuve rattachée à un irritant doit partager du vocabulaire métier avec lui.",
        "- **Exactitude des calculs** : une douzaine de faits clés par entreprise recalculés avec la bibliothèque "
        "standard (`evals/anchors.py`) ; chaque business case recalculé à partir de ses hypothèses avec les "
        "formules documentées (heures × coût horaire × 12, payback = coût projet / (gain net / 12), ROI 12/36 mois).",
        "- **Hallucinations** : (1) irritants, métriques, opportunités et hypothèses « fait/calcul » sans preuve "
        "liée ; (2) chaque nombre des titres, descriptions et recommandations doit correspondre, à la précision "
        "affichée près, à une valeur calculée, une preuve, une hypothèse, un seuil déclaré ou un nombre écrit "
        "dans une source texte.",
        "- **Stabilité** : ré-import du même dossier (tout est dédupliqué) puis ré-analyse ⇒ scores, rangs et "
        "étiquettes identiques ; chaque coefficient de priorisation est ensuite varié de ±20 %.",
        "- **Synthèse dirigeant** : grille de contrôle (potentiel annoncé, irritants critiques nommés, décision "
        "citant une P1, chaque P1 chiffrée, hypothèses signalées, longueur).",
        "",
        "Limites : l'appariement lexical peut être trompé par des formulations très éloignées ; la grille de "
        "synthèse vérifie la présence des éléments, pas la qualité rédactionnelle ; les valeurs du kit sont des "
        "estimations, pas des vérités terrain — l'écart de valeur est donc publié, pas noté.",
        "",
    ]
    return "\n".join(out)


def _company(r: dict) -> list[str]:
    issues, values, ev, h = r["issues"], r["values"], r["evidence"], r["hallucination"]
    out = [
        f"## {r['company']}",
        "",
        f"{r['sources']} sources analysées en {r['seconds']} s · {issues['pain_points']} irritants · "
        f"{ev['evidence']} preuves liées · {h['numbers']} nombres contrôlés dans les textes générés.",
        "",
        "### Irritants plantés",
        "",
        "| Irritant attendu | Gravité | Irritant produit | Score | Criticité | Preuves |",
        "|---|---|---|---|---|---|",
    ]
    for m in issues["matches"]:
        matched = m["matched"] or "**non détecté**"
        if m["hypothesis"]:
            matched += " _(hypothèse à valider)_"
        out.append(
            f"| {m['planted']} | {m['severity']} | {matched} | {m['score']:.2f} | {m['criticality'] or '—'} | {m['evidence']} |"
        )
    if issues["extras"]:
        out += ["", "Constats supplémentaires (hors corrigé) :", ""]
        out += [
            f"- {e['title']} — {e['evidence']} preuve(s) : {', '.join(e['files'])}" for e in issues["extras"]
        ]
    out += [
        "",
        "### Valeur annuelle vs estimations du kit",
        "",
        "| Opportunité attendue | Référence (MAD/an) | Opportunité produite | Moteur (MAD/an) | Ratio | Priorité |",
        "|---|---|---|---|---|---|",
    ]
    for v in values["rows"]:
        ratio = v["ratio"] if v["ratio"] is not None else "—"
        out.append(
            f"| {v['expected']} | {_mad(v['expected_value'])} | {v['matched'] or '—'} | {_mad(v['engine_value'])} | "
            f"{ratio} | {v['priority'] or '—'} |"
        )
    out += [
        "",
        f"Total moteur {_mad(values['engine_total'])} MAD/an (toutes opportunités) vs {_mad(values['expected_total'])} "
        "MAD/an pour les 5 opportunités du kit.",
        "",
        "### Calculs recalculés indépendamment",
        "",
        "| Métrique | Recalcul | Référence | Moteur | |",
        "|---|---|---|---|---|",
    ]
    for a in r["anchors"]["rows"]:
        engine = a["engine"] if a["engine"] is not None else "absente"
        out.append(
            f"| {a['label']} | `{a['how']}` | {a['reference']:g} | {engine} | {'✅' if a['ok'] else '❌'} |"
        )
    out += ["", f"Business cases : {r['roi']['checked']} recalculés, {len(r['roi']['mismatches'])} écart(s)."]
    if ev["failures"] or h["unsupported"] or h["untraceable"]:
        out += ["", "### Anomalies", ""]
        out += [f"- preuve : {f['summary']} — {f['reason']}" for f in ev["failures"]]
        out += [f"- {u}" for u in h["unsupported"]]
        out += [f"- nombre non traçable « {u['number']} » dans {u['where']}" for u in h["untraceable"]]
    sens = r["sensitivity"]
    out += [
        "",
        f"Stabilité : déterministe = {'oui' if r['deterministic'] else 'non'} ; {sens['perturbations']} perturbations, "
        f"τ min {sens['kendall_tau_min']}, τ moyen {sens['kendall_tau_mean']}, top 3 conservé {sens['top3_kept']:.0%}, "
        f"n°1 conservé {sens['top1_kept']:.0%}. Synthèse : {r['synthesis']['score']:.0%} des contrôles.",
        "",
    ]
    return out
