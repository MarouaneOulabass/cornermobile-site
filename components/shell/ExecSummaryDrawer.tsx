"use client";

import Link from "next/link";
import useSWR from "swr";
import { useMission } from "@/components/shell/MissionContext";
import { Drawer, Loading, Pill } from "@/components/ui";
import { mad, months, pct } from "@/lib/format";
import { CRITICALITY_LABELS, VALIDATION_LABELS } from "@/lib/labels";
import type { ExecSummary } from "@/lib/types";

export function ExecSummaryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { mission, base } = useMission();
  const { data } = useSWR<ExecSummary>(open ? `/missions/${mission.id}/summary` : null);
  return (
    <Drawer open={open} onClose={onClose} title="Résumé exécutif">
      {!data ? (
        <Loading />
      ) : (
        <div className="space-y-5 text-sm">
          <div>
            <div className="eyebrow">{data.organization}</div>
            <p className="mt-1 leading-relaxed">{data.headline}</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-value-soft p-3">
              <div className="text-lg font-extrabold text-value">{mad(data.stats.annual_value_mad)}</div>
              <div className="text-[11px] text-muted">valeur brute / an</div>
            </div>
            <div className="rounded-xl bg-risk-soft p-3">
              <div className="text-lg font-extrabold text-risk">{data.stats.pain_points_critical}</div>
              <div className="text-[11px] text-muted">irritants critiques</div>
            </div>
            <div className="rounded-xl bg-info-soft p-3">
              <div className="text-lg font-extrabold text-info">{pct(data.stats.validated_share)}</div>
              <div className="text-[11px] text-muted">conclusions revues</div>
            </div>
          </div>
          {data.decision && (
            <div className="rounded-xl border border-line p-3">
              <div className="eyebrow mb-1">Décision recommandée</div>
              <p>{data.decision}</p>
            </div>
          )}
          {data.top_opportunities.length > 0 && (
            <div>
              <div className="eyebrow mb-2">Opportunités prioritaires</div>
              <ul className="space-y-1.5">
                {data.top_opportunities.map((o) => (
                  <li key={o.id}>
                    <Link href={`${base}/opportunities/${o.id}`} onClick={onClose} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 hover:border-info">
                      <span className="min-w-0 truncate font-medium">{o.title}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Pill tone="value">{mad(o.gross_annual_value)}</Pill>
                        <span className="text-xs text-muted">{months(o.payback_months)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.top_pain_points.length > 0 && (
            <div>
              <div className="eyebrow mb-2">Irritants majeurs</div>
              <ul className="space-y-1.5">
                {data.top_pain_points.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{p.title}</span>
                    <span className="flex shrink-0 gap-1">
                      <Pill tone={CRITICALITY_LABELS[p.criticality]?.[1]}>{CRITICALITY_LABELS[p.criticality]?.[0]}</Pill>
                      <Pill tone={VALIDATION_LABELS[p.validation_status][1]}>{VALIDATION_LABELS[p.validation_status][0]}</Pill>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.caveats.length > 0 && (
            <ul className="space-y-1 rounded-xl bg-check-soft p-3 text-xs text-check">
              {data.caveats.map((c) => (
                <li key={c}>• {c}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Drawer>
  );
}
