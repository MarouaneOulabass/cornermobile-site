/** Missions: default interview guide, portfolio state and complete deletion. */
import { db as defaultDb, sql, type Db } from "../db";
import { Criticality, DocumentStatus, MissionStatus, ValidationStatus } from "../domain/enums";
import { pyRound, pyRoundInt, sum } from "../lib/py";
import type { MissionRow } from "../rows";
import { getStorage, missionPrefix } from "../storage";

const DEFAULT_INTERVIEWS: [string, string][] = [
  ["dir", "Direction générale : objectifs, irritants perçus, budget et horizon de décision"],
  ["fin", "Finance : clôture, encaissement, reporting et qualité des données"],
  ["ops", "Opérations : flux principal, outils, ressaisies et exceptions"],
  ["com", "Commercial / relation client : devis, réclamations, délais de réponse"],
  ["it", "IT : systèmes, exports disponibles, contraintes de sécurité"],
];

const STATUS_PROGRESS: Record<string, number> = {
  [MissionStatus.draft]: 0.05,
  [MissionStatus.ingesting]: 0.25,
  [MissionStatus.analyzing]: 0.45,
  [MissionStatus.review]: 0.6,
  [MissionStatus.published]: 1.0,
};

export function defaultChecklist(): { id: string; question: string; interviewee: string | null; done: boolean; notes: string | null }[] {
  return DEFAULT_INTERVIEWS.map(([id, question]) => ({ id, question, interviewee: null, done: false, notes: null }));
}

export async function latestMission(orgId: string, db: Db = defaultDb): Promise<MissionRow | null> {
  return db.maybeOne<MissionRow>(sql`SELECT * FROM audit_missions WHERE organization_id = ${orgId} ORDER BY created_at DESC, id LIMIT 1`);
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
  analysis_confidence: number | null;
  alerts: string[];
  progress: number;
}

export function emptyStats(): MissionStats {
  return {
    documents: 0,
    documents_indexed: 0,
    documents_error: 0,
    pain_points: 0,
    pain_points_critical: 0,
    opportunities: 0,
    opportunities_priority: 0,
    validated_share: 0.0,
    annual_value_mad: 0.0,
    analysis_confidence: null,
    alerts: [],
    progress: 0.0,
  };
}

export async function missionStats(mission: Pick<MissionRow, "id" | "status">, db: Db = defaultDb): Promise<MissionStats> {
  const mid = mission.id;
  const docCounts = new Map(
    (await db.query<{ status: string; n: number }>(sql`SELECT status, count(*)::int AS n FROM documents WHERE mission_id = ${mid} GROUP BY status`)).map((r) => [r.status, r.n]),
  );
  const pains = await db.query<{ criticality: string; validation_status: string; confidence: number }>(sql`
    SELECT criticality, validation_status, confidence FROM pain_points
    WHERE mission_id = ${mid} AND validation_status <> ${ValidationStatus.rejete} ORDER BY ordinal, created_at, id`);
  const opps = await db.query<{ priority_label: string | null; validation_status: string; results: Record<string, unknown> | null }>(sql`
    SELECT o.priority_label, o.validation_status, r.results FROM opportunities o LEFT JOIN roi_models r ON r.opportunity_id = o.id
    WHERE o.mission_id = ${mid} AND o.validation_status <> ${ValidationStatus.rejete} ORDER BY o.ordinal, o.created_at, o.id`);

  const reviewable = [...pains.map((p) => p.validation_status), ...opps.map((o) => o.validation_status)];
  const reviewed = reviewable.filter((s) => s === ValidationStatus.valide || s === ValidationStatus.corrige).length;
  const validatedShare = reviewable.length ? reviewed / reviewable.length : 0.0;
  const critical = pains.filter((p) => p.criticality === Criticality.critique).length;
  const value = sum(opps.map((o) => Number((o.results ?? {}).gross_annual_value || 0)));

  const alerts: string[] = [];
  const errors = docCounts.get(DocumentStatus.error) ?? 0;
  if (errors) alerts.push(`${errors} fichier(s) en erreur d'import`);
  const toCheck = pains.filter((p) => p.criticality === Criticality.critique && p.validation_status === ValidationStatus.a_verifier).length;
  if (toCheck) alerts.push(`${toCheck} irritant(s) critique(s) à vérifier`);

  const base = STATUS_PROGRESS[mission.status] ?? 0.0;
  const progress = mission.status === MissionStatus.published ? base : Math.min(0.95, base + 0.35 * validatedShare);
  return {
    documents: sum(docCounts.values()),
    documents_indexed: docCounts.get(DocumentStatus.indexed) ?? 0,
    documents_error: errors,
    pain_points: pains.length,
    pain_points_critical: critical,
    opportunities: opps.length,
    opportunities_priority: opps.filter((o) => o.priority_label === "P1").length,
    validated_share: pyRound(validatedShare, 3),
    annual_value_mad: pyRoundInt(value),
    analysis_confidence: pains.length ? pyRound(sum(pains.map((p) => p.confidence)) / pains.length, 3) : null,
    alerts,
    progress: pyRound(progress, 3),
  };
}

/** Complete deletion: database rows (cascade) and every stored file of the mission. */
export async function deleteMission(mission: Pick<MissionRow, "id" | "organization_id">, db: Db = defaultDb): Promise<number> {
  const removed = await getStorage().deletePrefix(missionPrefix(mission.organization_id, mission.id));
  await db.exec(sql`DELETE FROM audit_missions WHERE id = ${mission.id}`);
  return removed;
}
