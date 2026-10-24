/**
 * Deterministic ROI engine (spec §7). Pure functions: same assumptions in, same numbers out.
 *
 * A business case is a list of value lines over named assumptions:
 *   - "time":    hours/month = Π factors ; value/year = hours × hourly cost × 12
 *   - "product": value/year  = Π factors × annualize
 * plus a one-off project cost and a recurring run cost.
 */
import { pyRound } from "../lib/py";

export interface ValueLine {
  key: string;
  label: string;
  kind: string; // time | product
  factors: string[];
  cost_key: string | null; // time lines: hourly cost assumption
  annualize: number; // product lines expressed per month are ×12, yearly ones ×1
  family: string; // cost | revenue | risk — feeds the scoring sub-scores
  scale: number; // constant factor, e.g. 1/60 to turn minutes into hours
}

export function valueLine(
  key: string,
  label: string,
  kind: string,
  factors: string[],
  opts: { cost_key?: string | null; annualize?: number; family?: string; scale?: number } = {},
): ValueLine {
  return { key, label, kind, factors, cost_key: opts.cost_key ?? null, annualize: opts.annualize ?? 12.0, family: opts.family ?? "cost", scale: opts.scale ?? 1.0 };
}

export interface RoiLineDetail {
  key: string;
  label: string;
  kind: string;
  family: string;
  hours_month: number;
  annual_value: number;
}

export interface RoiResult {
  hours_saved_month: number;
  gross_annual_value: number;
  annual_solution_cost: number;
  project_cost: number;
  net_annual_gain: number;
  payback_months: number | null;
  roi_12m: number | null;
  roi_36m: number | null;
  by_family: Record<string, number>;
}

export class MissingAssumption extends Error {
  constructor(readonly key: string) {
    super(`missing assumption ${key}`);
    this.name = "MissingAssumption";
  }
}

function get(values: Record<string, number>, key: string): number {
  if (!(key in values)) throw new MissingAssumption(key);
  const v = Number(values[key]);
  if (!Number.isFinite(v)) throw new Error(`invalid value for ${key}`);
  return v;
}

export function compute(
  lines: ValueLine[],
  values: Record<string, number>,
  projectCostKey = "project_cost",
  runCostKey = "run_cost_month",
): { result: RoiResult; lines: RoiLineDetail[] } {
  let hoursTotal = 0.0;
  let gross = 0.0;
  const byFamily = new Map<string, number>();
  const detail: RoiLineDetail[] = [];
  for (const line of lines) {
    let product = line.scale;
    for (const f of line.factors) product *= get(values, f);
    let hours: number;
    let value: number;
    if (line.kind === "time") {
      hours = product;
      value = hours * get(values, line.cost_key || "hourly_cost_mad") * 12;
      hoursTotal += hours;
    } else {
      hours = 0.0;
      value = product * line.annualize;
    }
    gross += value;
    byFamily.set(line.family, (byFamily.get(line.family) ?? 0.0) + value);
    detail.push({ key: line.key, label: line.label, kind: line.kind, family: line.family, hours_month: pyRound(hours, 2), annual_value: pyRound(value, 2) });
  }
  const project = get(values, projectCostKey);
  const runYear = get(values, runCostKey) * 12;
  const net = gross - runYear;
  return {
    result: {
      hours_saved_month: pyRound(hoursTotal, 2),
      gross_annual_value: pyRound(gross, 2),
      annual_solution_cost: pyRound(runYear, 2),
      project_cost: pyRound(project, 2),
      net_annual_gain: pyRound(net, 2),
      payback_months: net > 0 ? pyRound(project / (net / 12), 2) : null,
      roi_12m: project > 0 ? pyRound((net - project) / project, 4) : null,
      roi_36m: project > 0 ? pyRound((3 * net - project) / project, 4) : null,
      by_family: Object.fromEntries([...byFamily].map(([k, v]) => [k, pyRound(v, 2)])),
    },
    lines: detail,
  };
}

export function linesFromJson(data: Record<string, unknown>[]): ValueLine[] {
  return data.map((d) => ({
    key: d.key as string,
    label: d.label as string,
    kind: d.kind as string,
    factors: [...(d.factors as string[])],
    cost_key: (d.cost_key as string | null | undefined) ?? null,
    annualize: Number(d.annualize ?? 12),
    family: (d.family as string | undefined) ?? "cost",
    scale: Number(d.scale ?? 1.0),
  }));
}

export function linesToJson(lines: ValueLine[]): Record<string, unknown>[] {
  return lines.map((ln) => ({
    key: ln.key,
    label: ln.label,
    kind: ln.kind,
    factors: [...ln.factors],
    cost_key: ln.cost_key,
    annualize: ln.annualize,
    family: ln.family,
    scale: ln.scale,
  }));
}
