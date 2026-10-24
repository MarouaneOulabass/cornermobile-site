"use client";

import { useState } from "react";
import { EvidencePanel } from "@/components/evidence/EvidencePanel";
import { NatureBadge } from "@/components/findings/Badges";
import { useMission } from "@/components/shell/MissionContext";
import { Drawer } from "@/components/ui";
import { metricValue } from "@/lib/format";
import type { Metric } from "@/lib/types";

function inputText(value: unknown): string {
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const v = value as { value: unknown; nature?: string };
    return `${String(v.value)}${v.nature ? ` (${v.nature === "hypothese" ? "hypothèse" : v.nature})` : ""}`;
  }
  return String(value);
}

/** Every number is clickable: it opens the formula, its inputs (fact / hypothesis) and the cited rows. */
export function MetricTable({ metrics }: { metrics: Metric[] }) {
  const { mission } = useMission();
  const [open, setOpen] = useState<Metric | null>(null);
  if (!metrics.length) return null;
  return (
    <>
      <table className="table-base">
        <thead>
          <tr>
            <th>Indicateur</th>
            <th className="text-right">Valeur</th>
            <th>Nature</th>
          </tr>
        </thead>
        <tbody>
          {metrics.map((m) => (
            <tr key={m.id} className="cursor-pointer hover:bg-gray-50" onClick={() => setOpen(m)} data-testid="metric-row">
              <td>
                <div>{m.label}</div>
                <div className="font-mono text-[11px] text-muted">{m.formula}</div>
              </td>
              <td className="whitespace-nowrap text-right font-bold">{metricValue(m.value, m.unit)}</td>
              <td>
                <NatureBadge nature={m.nature} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open?.label ?? ""} width="max-w-2xl">
        {open && (
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-extrabold">{metricValue(open.value, open.unit)}</span>
              <NatureBadge nature={open.nature} />
            </div>
            <div>
              <div className="eyebrow mb-1">Calcul</div>
              <div className="rounded-lg bg-gray-50 p-2 font-mono text-xs">{open.formula}</div>
            </div>
            {Object.keys(open.inputs).length > 0 && (
              <div>
                <div className="eyebrow mb-1">Entrées</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {Object.entries(open.inputs).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted">{k}</dt>
                      <dd>{inputText(v)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            <div>
              <div className="eyebrow mb-1">Preuves</div>
              <EvidencePanel missionId={mission.id} targetType="metric" targetId={open.id} emptyLabel="Indicateur dérivé des preuves de l'irritant." />
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}
