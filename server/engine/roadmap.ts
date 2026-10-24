/**
 * Roadmap generation (spec §9 écran 8): 30/60/90 days, then a 12-month portfolio.
 *
 * Rules, in order:
 *   - enablers first (validate hypotheses in interviews, collect missing data, governance);
 *   - quick wins (low effort, P1/P2) start in the first 30 days;
 *   - medium-effort P1/P2 become pilots in days 30-60 (at most 2 pilots starting together), followed by a deployment item;
 *   - high effort, low data readiness or P3 go to the 12-month portfolio;
 *   - explicit dependencies push an item after its prerequisite.
 */
import { randomUUID } from "node:crypto";
import { sql, type Db } from "../db";
import { EffortLevel, RoadmapPhase, ValidationStatus } from "../domain/enums";
import { pyGrouped, pyRoundInt, sortedBy, sum } from "../lib/py";
import type { OpportunityRow } from "../rows";

export const PHASE_WEEKS: [string, [number, number]][] = [
  [RoadmapPhase.j30, [0, 3]],
  [RoadmapPhase.j60, [4, 8]],
  [RoadmapPhase.j90, [9, 12]],
  [RoadmapPhase.t2, [13, 25]],
  [RoadmapPhase.t3, [26, 38]],
  [RoadmapPhase.t4, [39, 51]],
];
const PHASE_RANGE = new Map(PHASE_WEEKS);

// dependent → prerequisites (by opportunity code)
export const DEPENDS_ON: Record<string, string[]> = {
  "opp:invoicing_flow": ["opp:field_reports"], // invoicing needs structured intervention reports
  "opp:sla_radar": ["opp:support_assistant"], // the radar reads timestamps from the single ticketing tool
};
const MAX_PILOTS_PER_PHASE = 2;

export function phaseForWeek(week: number): string {
  for (const [phase, [lo, hi]] of PHASE_WEEKS) if (lo <= week && week <= hi) return phase;
  return RoadmapPhase.t4;
}

function weeksOf(delivery: string | null, fallback: number): number {
  const nums = (delivery ?? "").match(/\d+/g)?.map(Number) ?? [];
  return nums.length ? Math.max(...nums) : fallback;
}

export type PlannedOpportunity = Pick<
  OpportunityRow,
  "id" | "code" | "title" | "summary" | "effort" | "priority_label" | "priority_score" | "target_delivery" | "department" | "pilot_plan" | "generated" | "validation_status"
> & { results: Record<string, unknown> | null; natures: string[] };

class ItemSpec {
  dependsOn: string[] = [];
  constructor(
    readonly key: string,
    readonly title: string,
    readonly description: string,
    readonly kind: string,
    public startWeek: number,
    readonly durationWeeks: number,
    readonly owner: string | null = null,
    readonly opportunity: PlannedOpportunity | null = null,
    dependsOn: string[] = [],
  ) {
    this.dependsOn = dependsOn;
  }

  get phase(): string {
    return phaseForWeek(this.startWeek);
  }

  get endWeek(): number {
    return this.startWeek + this.durationWeeks;
  }
}

export function plan(insights: Record<string, unknown>, opps: PlannedOpportunity[], hypotheses: number): ItemSpec[] {
  const items: ItemSpec[] = [];
  const active = sortedBy(
    opps.filter((o) => o.validation_status !== ValidationStatus.rejete),
    (o) => -o.priority_score,
  );
  const completeness = (insights?.completeness ?? {}) as { gaps?: string[] };
  const gaps = (completeness.gaps ?? []).filter((g) => g.startsWith("Période"));

  items.push(
    new ItemSpec(
      "socle:governance",
      "Lancement : sponsor, comité de pilotage, indicateurs de référence",
      "Nommer le sponsor et les propriétaires de chaque chantier, figer la mesure de départ (baseline).",
      "socle",
      0,
      2,
      "Direction",
    ),
  );
  if (hypotheses || active.slice(0, 5).some((o) => o.natures.includes("hypothese"))) {
    items.push(
      new ItemSpec(
        "socle:validate",
        "Validation des hypothèses en entretien",
        "Confirmer volumes, temps unitaires et coûts horaires des business cases prioritaires" + (hypotheses ? ` ; ${hypotheses} irritant(s) à confirmer` : "") + ".",
        "socle",
        0,
        3,
        "Consultant",
      ),
    );
  }
  if (gaps.length) items.push(new ItemSpec("socle:data", "Collecte des données manquantes", [...gaps.join(" ; ")].slice(0, 500).join(""), "socle", 1, 4, "DSI / métiers"));

  const pilotsByPhase = new Map<string, number>();
  const placed = new Map<string, ItemSpec>();
  for (const o of active) {
    const readiness = ((o.generated ?? {}).data_readiness as number | undefined) ?? 0.6;
    const weeks = weeksOf(o.target_delivery, 8);
    const value = o.results ? ((o.results.gross_annual_value as number | undefined) ?? 0) : 0;
    const desc = `${o.summary} Valeur estimée : ${pyGrouped(pyRoundInt(value / 1000), 0)} k MAD/an.`.replaceAll(",", " ");
    let spec: ItemSpec;
    if (o.effort === EffortLevel.faible && (o.priority_label === "P1" || o.priority_label === "P2") && readiness >= 0.4) {
      spec = new ItemSpec(`${o.code}:quick`, o.title, desc, "quick_win", 1, weeks, o.department, o);
    } else if (o.effort !== EffortLevel.eleve && (o.priority_label === "P1" || o.priority_label === "P2") && readiness >= 0.4) {
      let start = 4;
      while ((pilotsByPhase.get(phaseForWeek(start)) ?? 0) >= MAX_PILOTS_PER_PHASE) start = (PHASE_RANGE.get(phaseForWeek(start)) as [number, number])[1] + 1;
      pilotsByPhase.set(phaseForWeek(start), (pilotsByPhase.get(phaseForWeek(start)) ?? 0) + 1);
      const pilotWeeks = sum((o.pilot_plan ?? []).map((p) => p.weeks ?? 0)) || weeks;
      spec = new ItemSpec(`${o.code}:pilot`, `Pilote — ${o.title}`, desc, "pilote", start, pilotWeeks, o.department, o);
    } else {
      const start = o.priority_label === "P1" || o.priority_label === "P2" ? 13 : 26;
      spec = new ItemSpec(`${o.code}:project`, o.title, desc + (readiness < 0.4 ? " Prérequis : données à collecter." : ""), "projet", start, weeks, o.department, o);
    }
    items.push(spec);
    placed.set(o.code, spec);
  }

  // Dependencies: a dependent starts after its prerequisites end.
  for (const [dependent, prerequisites] of Object.entries(DEPENDS_ON)) {
    const dep = placed.get(dependent);
    if (!dep) continue;
    for (const prereq of prerequisites) {
      const pre = placed.get(prereq);
      if (pre && dep.startWeek <= pre.endWeek) {
        dep.startWeek = pre.endWeek + 1;
        dep.dependsOn.push(pre.key);
      }
    }
  }

  // Each pilot is followed by its deployment once the gains are measured.
  for (const [code, spec] of placed) {
    if (spec.kind === "pilote") {
      items.push(
        new ItemSpec(
          `${code}:deploy`,
          `Déploiement — ${(spec.opportunity as PlannedOpportunity).title}`,
          "Extension à toutes les équipes après mesure des gains du pilote.",
          "industrialisation",
          spec.endWeek + 1,
          6,
          spec.owner,
          spec.opportunity,
          [spec.key],
        ),
      );
    }
  }
  if (items.some((i) => i.kind === "quick_win")) {
    items.push(
      new ItemSpec(
        "socle:measure",
        "Mesure des gains des quick wins et arbitrage des déploiements",
        "Comparer les indicateurs aux valeurs de référence, recalibrer les business cases.",
        "socle",
        10,
        2,
        "Direction",
      ),
    );
  }
  return items;
}

interface RoadmapRow {
  id: string;
  start_week: number;
  validation_status: string;
  generated: Record<string, unknown>;
  edited_fields: string[];
}

export async function loadPlannedOpportunities(db: Db, missionId: string): Promise<PlannedOpportunity[]> {
  const opps = await db.query<OpportunityRow & { results: Record<string, unknown> | null }>(sql`
    SELECT o.*, r.results FROM opportunities o LEFT JOIN roi_models r ON r.opportunity_id = o.id
    WHERE o.mission_id = ${missionId} ORDER BY o.ordinal, o.created_at, o.id`);
  const natures = await db.query<{ opportunity_id: string; nature: string }>(sql`SELECT opportunity_id, nature FROM assumptions WHERE mission_id = ${missionId} ORDER BY ordinal`);
  return opps.map((o) => ({ ...o, natures: natures.filter((a) => a.opportunity_id === o.id).map((a) => a.nature) }));
}

export async function persistRoadmap(db: Db, missionId: string): Promise<number> {
  const mission = await db.one<{ organization_id: string; insights: Record<string, unknown> }>(sql`SELECT organization_id, insights FROM audit_missions WHERE id = ${missionId}`);
  const opps = await loadPlannedOpportunities(db, missionId);
  const hypotheses = (await db.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM pain_points WHERE mission_id = ${missionId} AND is_hypothesis`)).n;
  const specs = plan(mission.insights, opps, hypotheses);
  const rows = await db.query<RoadmapRow>(sql`SELECT id, start_week, validation_status, generated, edited_fields FROM roadmap_items WHERE mission_id = ${missionId} ORDER BY ordinal, created_at, id`);
  const existing = new Map<string, RoadmapRow>();
  for (const r of rows) if (r.generated?.key) existing.set(r.generated.key as string, r);
  let count = 0;
  const ordered = sortedBy(specs, (s) => [s.startWeek, s.kind !== "socle"]);
  for (const [ordinal, spec] of ordered.entries()) {
    const item = existing.get(spec.key);
    existing.delete(spec.key);
    const values: Record<string, unknown> = {
      title: spec.title,
      description: spec.description,
      kind: spec.kind,
      phase: spec.phase,
      start_week: spec.startWeek,
      duration_weeks: spec.durationWeeks,
      owner: spec.owner,
    };
    const edited = new Set(item?.edited_fields ?? []);
    const fields = Object.keys(values).filter((k) => !edited.has(k));
    const generated = { key: spec.key, ...values };
    const opportunityId = spec.opportunity ? spec.opportunity.id : null;
    if (!item) {
      await db.exec(sql`
        INSERT INTO roadmap_items (id, organization_id, mission_id, opportunity_id, depends_on, ordinal, generated, ${sql.raw(fields.join(", "))})
        VALUES (${randomUUID()}, ${mission.organization_id}, ${missionId}, ${opportunityId}, ${sql.json(spec.dependsOn)}, ${ordinal}, ${sql.json(generated)},
          ${sql.join(fields.map((k) => sql`${values[k]}`))})`);
    } else {
      const sets = fields.map((k) => sql`${sql.raw(k)} = ${values[k]}`);
      if (edited.has("start_week") && !edited.has("phase")) sets.push(sql`phase = ${phaseForWeek(item.start_week)}`);
      await db.exec(sql`
        UPDATE roadmap_items SET ${sql.join([...sets, sql`opportunity_id = ${opportunityId}`, sql`depends_on = ${sql.json(spec.dependsOn)}`, sql`ordinal = ${ordinal}`, sql`generated = ${sql.json(generated)}`])}
        WHERE id = ${item.id}`);
    }
    count++;
  }
  for (const stale of existing.values()) {
    if (!(stale.edited_fields ?? []).length && stale.validation_status === ValidationStatus.a_verifier) await db.exec(sql`DELETE FROM roadmap_items WHERE id = ${stale.id}`);
    else count++;
  }
  return count;
}
