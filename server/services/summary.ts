/**
 * Executive summary (spec §9 écran 9, §10 "résumé exécutif toujours accessible").
 *
 * Built only from stored, traceable items: every number here comes from an ROI model or a metric.
 */
import { db as defaultDb, sql, type Db } from "../db";
import { ValidationStatus } from "../domain/enums";
import { pyCapitalize, pyFixed, pyGrouped, pyRoundInt, sortedBy, sum } from "../lib/py";
import type { MissionRow } from "../rows";
import { type MissionStats, missionStats } from "./missions";

const CRIT_ORDER: Record<string, number> = { critique: 0, elevee: 1, moyenne: 2, faible: 3 };

export interface SummaryOpportunity {
  id: string;
  title: string;
  priority_label: string | null;
  gross_annual_value: number | null;
  payback_months: number | null;
  effort: string;
  validation_status: string;
}

export interface SummaryPainPoint {
  id: string;
  title: string;
  criticality: string;
  confidence: number;
  is_hypothesis: boolean;
  validation_status: string;
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

function fmtMad(value: number): string {
  if (value >= 1_000_000) return `${pyFixed(value / 1_000_000, 2)} M MAD`.replaceAll(".", ",");
  return `${pyGrouped(pyRoundInt(value / 1000), 0)} k MAD`.replaceAll(",", " ");
}

export async function executiveSummary(mission: MissionRow, db: Db = defaultDb): Promise<ExecSummary> {
  const stats = await missionStats(mission, db);
  const org = await db.one<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${mission.organization_id}`);
  const opps = await db.query<{ id: string; title: string; priority_label: string | null; effort: string; validation_status: string; results: Record<string, unknown> | null }>(sql`
    SELECT o.id, o.title, o.priority_label, o.effort, o.validation_status, r.results FROM opportunities o
    LEFT JOIN roi_models r ON r.opportunity_id = o.id
    WHERE o.mission_id = ${mission.id} AND o.validation_status <> ${ValidationStatus.rejete}
    ORDER BY o.priority_score DESC, o.ordinal, o.created_at, o.id`);
  const pains = sortedBy(
    await db.query<SummaryPainPoint>(sql`
      SELECT id, title, criticality, confidence, is_hypothesis, validation_status FROM pain_points
      WHERE mission_id = ${mission.id} AND validation_status <> ${ValidationStatus.rejete} ORDER BY ordinal, created_at, id`),
    (p) => [CRIT_ORDER[p.criticality] ?? 9, -p.confidence],
  );

  const topOpps: SummaryOpportunity[] = opps.slice(0, 5).map((o) => ({
    id: o.id,
    title: o.title,
    priority_label: o.priority_label,
    gross_annual_value: ((o.results ?? {}).gross_annual_value as number | undefined) ?? null,
    payback_months: ((o.results ?? {}).payback_months as number | undefined) ?? null,
    effort: o.effort,
    validation_status: o.validation_status,
  }));
  const p1 = topOpps.filter((o) => o.priority_label === "P1");
  let headline: string;
  if (stats.opportunities) {
    const valueP1 = sum(p1.map((o) => o.gross_annual_value || 0));
    headline =
      `${stats.pain_points} irritants documentés, ${stats.opportunities} opportunités chiffrées. ` +
      `Les ${p1.length} opportunités prioritaires représentent un potentiel brut estimé à ` +
      `${fmtMad(valueP1)}/an, sous réserve de validation des hypothèses.`;
  } else if (stats.documents) {
    headline = `${stats.documents} sources importées. Lancez l'analyse pour obtenir le diagnostic.`;
  } else {
    headline = "Mission en préparation : importez les documents et données de l'entreprise.";
  }

  let decision: string | null = null;
  if (p1.length) {
    const quick = p1
      .filter((o) => o.effort === "faible")
      .map((o) => o.title)
      .slice(0, 2);
    const pilot = p1.find((o) => o.effort !== "faible")?.title ?? null;
    const parts: string[] = [];
    if (quick.length) parts.push(`lancer immédiatement ${quick.join(" et ")}`);
    if (pilot) parts.push(`piloter « ${pilot} »`);
    decision = pyCapitalize(`${parts.join(", puis ")}, et mesurer les gains avant extension.`);
  }

  const caveats: string[] = [];
  const unvalidated = topOpps.filter((o) => o.validation_status === ValidationStatus.a_verifier);
  if (unvalidated.length) caveats.push(`${unvalidated.length} opportunité(s) majeure(s) pas encore validée(s) par le consultant.`);
  const hypotheses = pains.filter((p) => p.is_hypothesis);
  if (hypotheses.length) caveats.push(`${hypotheses.length} irritant(s) reposent sur une hypothèse à valider en entretien.`);

  return {
    organization: org.name,
    mission: mission.name,
    headline,
    stats,
    top_opportunities: topOpps,
    top_pain_points: pains.slice(0, 5).map((p) => ({
      id: p.id,
      title: p.title,
      criticality: p.criticality,
      confidence: p.confidence,
      is_hypothesis: p.is_hypothesis,
      validation_status: p.validation_status,
    })),
    decision,
    caveats,
  };
}
