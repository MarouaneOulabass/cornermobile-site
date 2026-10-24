/** Markdown rendering of the eval results (docs/evals/report.md). */
import { pyFixed, pyFloatStr, pyG, pyGrouped } from "../server/lib/py";
import type { CompanyResult, EvalResults } from "./runner";

const LABELS: Record<string, string> = {
  recall: "Recall des irritants attendus",
  precision_supported: "Précision (irritants étayés par une preuve vérifiée ou signalés en hypothèse)",
  evidence_fidelity: "Fidélité des preuves (citation retrouvée telle quelle dans le fichier d'origine)",
  evidence_relevance: "Pertinence des preuves (la preuve parle du constat qu'elle étaye)",
  anchor_accuracy: "Exactitude des métriques (recalcul indépendant depuis les CSV)",
  roi_accuracy: "Exactitude des business cases (recalcul indépendant des formules ROI)",
  unsupported_rate: "Éléments sans preuve ni statut d'hypothèse",
  untraceable_rate: "Chiffres non traçables dans les textes générés",
  deterministic: "Déterminisme (ré-import + ré-analyse ⇒ classement identique)",
  kendall_tau_min: "Stabilité du classement (τ de Kendall minimal, coefficients ±20 %)",
  synthesis: "Qualité de la synthèse dirigeant (grille de contrôle)",
  answer_key_isolated: "Corrigé du kit jamais ingéré",
  errors: "Analyses sans erreur",
};

function fmt(value: unknown): string {
  if (typeof value === "boolean") return value ? "oui" : "non";
  if (typeof value === "number") return value % 1 ? pyFixed(value, 3).replace(/0+$/, "").replace(/\.$/, "") : pyFixed(value, 0);
  if (Array.isArray(value)) return value.length ? `${value.length} erreur(s)` : "aucune";
  return value === null || value === undefined ? "—" : String(value);
}

function mad(value: number | null): string {
  return value === null ? "—" : `${pyGrouped(value / 1000, 0, " ")} k`;
}

function target(key: string, value: number | boolean | undefined): string {
  if (value === undefined) return "—";
  if (typeof value === "boolean") return fmt(value);
  return (key.endsWith("_rate") ? "≤ " : "≥ ") + fmt(value);
}

function percent(x: number): string {
  return `${pyFixed(x * 100, 0)}%`;
}

export function renderMarkdown(results: EvalResults, now = new Date()): string {
  const s = results.summary;
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const out = [
    "# Évaluation AuditFlow sur le jeu de démonstration",
    "",
    `_Généré le ${stamp} UTC par \`npm run evals\` (evals/)._`,
    "",
    "Le moteur analyse chaque entreprise exactement comme en production (import du dossier, analyse " +
      "déterministe, aucun LLM). Le corrigé `ground_truth.json` n'est lu que par le module d'évaluation, " +
      "après coup. Les mesures suivent le §14 du cahier des charges.",
    "",
    "## Synthèse",
    "",
    "| Mesure | Résultat | Seuil | |",
    "|---|---|---|---|",
  ];
  for (const [key, ok] of Object.entries(s.passed)) {
    out.push(`| ${LABELS[key] ?? key} | ${fmt(s[key])} | ${target(key, results.thresholds[key])} | ${ok ? "✅" : "❌"} |`);
  }
  out.push(
    "",
    `Indicateurs complémentaires : recall direct (hors hypothèses) ${fmt(s.recall_direct)}, ` +
      `précision stricte vs corrigé ${fmt(s.precision_strict)}, top 3 conservé sous perturbation ` +
      `${fmt(s.top3_kept)}, ratio médian valeur moteur / valeur de référence ${fmt(s.value_median_ratio)}.`,
    "",
    "La précision stricte compte comme faux positif tout irritant absent du corrigé. Elle est basse par " +
      "construction : le moteur remonte aussi des constats documentés que le corrigé ne liste pas " +
      "(créances, procédures, SLA…). Ils sont listés plus bas avec leurs sources pour revue humaine.",
    "",
  );
  for (const r of results.companies) out.push(...company(r));
  out.push(
    "## Méthode",
    "",
    "- **Recall / précision** : appariement lexical (racines de mots, domaine) entre chaque irritant planté " +
      "et les irritants produits, affectation un-à-un ; les scores d'appariement sont publiés ci-dessus.",
    "- **Fidélité des preuves** : chaque preuve liée est relue dans le fichier d'origine, indépendamment de " +
      "l'ingestion — lignes de texte identiques, cellules CSV identiques (ligne, colonne, valeur), colonnes et " +
      "numéros de ligne existants.",
    "- **Pertinence** : une preuve rattachée à un irritant doit partager du vocabulaire métier avec lui.",
    "- **Exactitude des calculs** : une douzaine de faits clés par entreprise recalculés avec un lecteur CSV " +
      "distinct de l'ingestion (`evals/anchors.ts`) ; chaque business case recalculé à partir de ses hypothèses avec les " +
      "formules documentées (heures × coût horaire × 12, payback = coût projet / (gain net / 12), ROI 12/36 mois).",
    "- **Hallucinations** : (1) irritants, métriques, opportunités et hypothèses « fait/calcul » sans preuve " +
      "liée ; (2) chaque nombre des titres, descriptions et recommandations doit correspondre, à la précision " +
      "affichée près, à une valeur calculée, une preuve, une hypothèse, un seuil déclaré ou un nombre écrit " +
      "dans une source texte.",
    "- **Stabilité** : ré-import du même dossier (tout est dédupliqué) puis ré-analyse ⇒ scores, rangs et " +
      "étiquettes identiques ; chaque coefficient de priorisation est ensuite varié de ±20 %.",
    "- **Synthèse dirigeant** : grille de contrôle (potentiel annoncé, irritants critiques nommés, décision " +
      "citant une P1, chaque P1 chiffrée, hypothèses signalées, longueur).",
    "",
    "Limites : l'appariement lexical peut être trompé par des formulations très éloignées ; la grille de " +
      "synthèse vérifie la présence des éléments, pas la qualité rédactionnelle ; les valeurs du kit sont des " +
      "estimations, pas des vérités terrain — l'écart de valeur est donc publié, pas noté.",
    "",
  );
  return out.join("\n");
}

function company(r: CompanyResult): string[] {
  const { issues, values, evidence: ev, hallucination: h } = r;
  const out = [
    `## ${r.company}`,
    "",
    `${r.sources} sources analysées en ${pyFloatStr(r.seconds)} s · ${issues.pain_points} irritants · ` +
      `${ev.evidence} preuves liées · ${h.numbers} nombres contrôlés dans les textes générés.`,
    "",
    "### Irritants plantés",
    "",
    "| Irritant attendu | Gravité | Irritant produit | Score | Criticité | Preuves |",
    "|---|---|---|---|---|---|",
  ];
  for (const m of issues.matches) {
    let matched = m.matched || "**non détecté**";
    if (m.hypothesis) matched += " _(hypothèse à valider)_";
    out.push(`| ${m.planted} | ${m.severity} | ${matched} | ${pyFixed(m.score, 2)} | ${m.criticality || "—"} | ${m.evidence} |`);
  }
  if (issues.extras.length) {
    out.push("", "Constats supplémentaires (hors corrigé) :", "");
    out.push(...issues.extras.map((e) => `- ${e.title} — ${e.evidence} preuve(s) : ${e.files.join(", ")}`));
  }
  out.push(
    "",
    "### Valeur annuelle vs estimations du kit",
    "",
    "| Opportunité attendue | Référence (MAD/an) | Opportunité produite | Moteur (MAD/an) | Ratio | Priorité |",
    "|---|---|---|---|---|---|",
  );
  for (const v of values.rows) {
    const ratio = v.ratio !== null ? pyFloatStr(v.ratio) : "—";
    out.push(`| ${v.expected} | ${mad(v.expected_value)} | ${v.matched || "—"} | ${mad(v.engine_value)} | ${ratio} | ${v.priority || "—"} |`);
  }
  out.push(
    "",
    `Total moteur ${mad(values.engine_total)} MAD/an (toutes opportunités) vs ${mad(values.expected_total)} ` + "MAD/an pour les 5 opportunités du kit.",
    "",
    "### Calculs recalculés indépendamment",
    "",
    "| Métrique | Recalcul | Référence | Moteur | |",
    "|---|---|---|---|---|",
  );
  for (const a of r.anchors.rows) {
    const engine = a.engine !== null ? pyFloatStr(a.engine) : "absente";
    out.push(`| ${a.label} | \`${a.how}\` | ${pyG(a.reference)} | ${engine} | ${a.ok ? "✅" : "❌"} |`);
  }
  out.push("", `Business cases : ${r.roi.checked} recalculés, ${r.roi.mismatches.length} écart(s).`);
  if (ev.failures.length || h.unsupported.length || h.untraceable.length) {
    out.push("", "### Anomalies", "");
    out.push(...ev.failures.map((f) => `- preuve : ${f.summary} — ${f.reason}`));
    out.push(...h.unsupported.map((u) => `- ${u}`));
    out.push(...h.untraceable.map((u) => `- nombre non traçable « ${u.number} » dans ${u.where}`));
  }
  const sens = r.sensitivity;
  out.push(
    "",
    `Stabilité : déterministe = ${r.deterministic ? "oui" : "non"} ; ${sens.perturbations} perturbations, ` +
      `τ min ${pyFloatStr(sens.kendall_tau_min)}, τ moyen ${pyFloatStr(sens.kendall_tau_mean)}, top 3 conservé ${percent(sens.top3_kept)}, ` +
      `n°1 conservé ${percent(sens.top1_kept)}. Synthèse : ${percent(r.synthesis.score)} des contrôles.`,
    "",
  );
  return out;
}
