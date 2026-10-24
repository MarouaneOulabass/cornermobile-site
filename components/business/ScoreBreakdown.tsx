"use client";

import { Bar } from "@/components/ui";
import { SCORE_LABELS } from "@/lib/labels";

/** Shows the eleven sub-scores and how the priority formula combines them (coefficients are configurable). */
export function ScoreBreakdown({ scores, weights, penalties, priority }: { scores: Record<string, number>; weights: Record<string, number>; penalties: Record<string, number>; priority: number }) {
  const positive = Object.entries(weights).filter(([, w]) => w > 0);
  const negative = Object.entries(penalties).filter(([, w]) => w > 0);
  return (
    <div className="space-y-4 text-xs" data-testid="score-breakdown">
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {Object.entries(SCORE_LABELS).map(([key, label]) => {
          const v = scores[key] ?? 0;
          const isPenalty = key in penalties;
          return (
            <div key={key}>
              <div className="mb-0.5 flex justify-between">
                <span className="text-muted">
                  {label}
                  {isPenalty && " (pénalité)"}
                </span>
                <b>{Math.round(v)}</b>
              </div>
              <Bar value={v / 100} tone={isPenalty ? "check" : "info"} />
            </div>
          );
        })}
      </div>
      <div className="rounded-lg bg-gray-50 p-3 font-mono text-[11px] leading-relaxed">
        Priorité = {positive.map(([k, w]) => `${w.toFixed(2)}×${SCORE_LABELS[k]}`).join(" + ")}
        {negative.length ? ` − ${negative.map(([k, w]) => `${w.toFixed(2)}×${SCORE_LABELS[k]}`).join(" − ")}` : ""}
        <br />= {positive.map(([k, w]) => (w * (scores[k] ?? 0)).toFixed(1)).join(" + ")}
        {negative.length ? ` − ${negative.map(([k, w]) => (w * (scores[k] ?? 0)).toFixed(1)).join(" − ")}` : ""} = <b>{priority.toFixed(1)}</b>
      </div>
    </div>
  );
}
