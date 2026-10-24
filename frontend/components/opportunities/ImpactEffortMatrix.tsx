"use client";

import Link from "next/link";
import { useMission } from "@/components/shell/MissionContext";
import { mad } from "@/lib/format";
import type { Opportunity } from "@/lib/types";

export function effortScore(o: Opportunity): number {
  const s = o.scores;
  return ((100 - (s.feasibility ?? 50)) + (s.technical_complexity ?? 50) + (s.change_effort ?? 50)) / 3;
}

const COLORS: Record<string, string> = { P1: "#15803d", P2: "#2563eb", P3: "#6b7280" };

/** Spread values over the mission's own range so a portfolio of similar scores stays readable. */
function scale(values: number[]): (v: number) => number {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return (v) => 10 + ((v - lo) / span) * 80;
}

/** Impact (vertical, high at the top) versus effort (horizontal, low on the left). Quick wins sit top-left. */
export function ImpactEffortMatrix({ items, highlight }: { items: Opportunity[]; highlight?: string }) {
  const { base } = useMission();
  if (!items.length) return null;
  const efforts = items.map(effortScore);
  const impacts = items.map((o) => o.scores.business_impact ?? 0);
  const sx = scale(efforts);
  const sy = scale(impacts);
  return (
    <div className="card p-3" data-testid="impact-effort-matrix">
      <div className="relative h-[380px] overflow-hidden rounded-xl border border-line bg-white">
        <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
        <div className="absolute inset-x-0 top-1/2 h-px bg-line" />
        <span className="absolute left-2 top-2 text-[11px] font-bold uppercase tracking-wider text-value">Quick wins</span>
        <span className="absolute right-2 top-2 text-[11px] font-bold uppercase tracking-wider text-info">Projets stratégiques</span>
        <span className="absolute bottom-2 left-2 text-[11px] font-bold uppercase tracking-wider text-muted">Améliorations</span>
        <span className="absolute bottom-2 right-2 text-[11px] font-bold uppercase tracking-wider text-muted">À reconsidérer</span>
        {items.map((o, i) => {
          const x = sx(efforts[i]);
          const y = 100 - sy(impacts[i]);
          const color = COLORS[o.priority_label ?? "P3"];
          return (
            <Link
              key={o.id}
              href={`${base}/opportunities/${o.id}`}
              className="group absolute z-10 -translate-x-1/2 -translate-y-1/2 hover:z-20"
              style={{ left: `${x}%`, top: `${y}%` }}
              aria-label={`${o.title} — ${mad(o.roi.gross_annual_value)} par an`}
            >
              <span
                className="grid size-7 place-items-center rounded-full border-2 border-white text-[11px] font-extrabold text-white shadow"
                style={{ background: color, outline: highlight === o.id ? "3px solid #f59e0b" : undefined }}
              >
                {o.priority_rank ?? "–"}
              </span>
              <span
                className={`pointer-events-none absolute top-full mt-1 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[11px] font-semibold text-white shadow ${
                  x > 65 ? "right-0" : x < 35 ? "left-0" : "left-1/2 -translate-x-1/2"
                } ${highlight === o.id ? "block" : "hidden group-hover:block group-focus:block"}`}
              >
                {o.title.length > 34 ? `${o.title.slice(0, 32)}…` : o.title} · {mad(o.roi.gross_annual_value)}
              </span>
            </Link>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
        <span>↑ Impact business · → Effort (complexité, changement, faisabilité inverse) — échelles relatives à la mission</span>
        <span className="flex gap-2">
          {Object.entries(COLORS).map(([k, c]) => (
            <span key={k} className="flex items-center gap-1">
              <i className="inline-block size-2.5 rounded-full" style={{ background: c }} /> {k}
            </span>
          ))}
          <span>· n° = rang de priorité</span>
        </span>
      </div>
    </div>
  );
}
