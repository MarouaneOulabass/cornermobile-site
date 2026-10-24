"use client";

import clsx from "clsx";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ConfidenceBadge, StatusBadge } from "@/components/findings/Badges";
import { ImpactEffortMatrix } from "@/components/opportunities/ImpactEffortMatrix";
import { useMission } from "@/components/shell/MissionContext";
import { Empty, Loading, PageHeader, Pill, Stat } from "@/components/ui";
import { mad, months } from "@/lib/format";
import { AI_CATEGORY_KEYS, CATEGORY_OPP_LABELS, EFFORT_LABELS, PRIORITY_TONES } from "@/lib/labels";
import type { Opportunity } from "@/lib/types";

const SORTS = [
  ["priority", "Priorité"],
  ["value", "Valeur annuelle"],
  ["payback", "Payback"],
  ["complexity", "Complexité"],
] as const;

export default function OpportunitiesPage() {
  const { mission, base } = useMission();
  const [sort, setSort] = useState<string>("priority");
  const [view, setView] = useState<"cards" | "table">("cards");
  const { data } = useSWR<Opportunity[]>(`/missions/${mission.id}/opportunities?sort=${sort}`);
  const active = (data ?? []).filter((o) => o.validation_status !== "rejete");
  const total = active.reduce((s, o) => s + (o.roi.gross_annual_value || 0), 0);
  const p1 = active.filter((o) => o.priority_label === "P1");

  return (
    <>
      <PageHeader eyebrow="Portefeuille" title="Opportunités" subtitle="Priorisation selon valeur, effort, risque et maturité des données. Chaque valeur est calculée à partir d'hypothèses visibles et modifiables." />
      <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <Stat label="Valeur brute annuelle" value={mad(total)} hint="somme des business cases" tone="value" />
        <Stat label="Prioritaires (P1)" value={p1.length} hint={mad(p1.reduce((s, o) => s + o.roi.gross_annual_value, 0))} />
        <Stat label="Avec IA" value={active.filter((o) => AI_CATEGORY_KEYS.has(o.category)).length} hint="uniquement là où elle est justifiée" />
        <Stat label="Quick wins" value={active.filter((o) => o.effort === "faible").length} hint="effort faible" />
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted" htmlFor="sort">
            Trier par
          </label>
          <select id="sort" className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="inline-flex rounded-lg border border-line bg-white p-0.5 text-sm" role="tablist">
          {(["cards", "table"] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} type="button" onClick={() => setView(v)} className={clsx("rounded-md px-3 py-1.5 font-semibold", view === v ? "bg-info text-white" : "text-muted")}>
              {v === "cards" ? "Cartes" : "Tableau"}
            </button>
          ))}
        </div>
      </div>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <div className="mt-4">
          <Empty title="Aucune opportunité">Lancez l&apos;analyse pour générer le portefeuille.</Empty>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div>
            {view === "cards" ? (
              <div className="space-y-2.5" data-testid="opp-list">
                {data.map((o) => (
                  <Link key={o.id} href={`${base}/opportunities/${o.id}`} className={clsx("block rounded-xl border border-line bg-white p-3.5 transition hover:border-info", o.validation_status === "rejete" && "opacity-50")}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-semibold">
                          {o.priority_rank && <span className="grid size-5 shrink-0 place-items-center rounded-full bg-gray-100 text-[10px] font-extrabold text-muted">{o.priority_rank}</span>}
                          {AI_CATEGORY_KEYS.has(o.category) && <Sparkles size={14} className="shrink-0 text-info" aria-label="IA" />}
                          {o.title}
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-xs text-muted">{o.summary}</div>
                      </div>
                      <Pill tone="value">{mad(o.roi.gross_annual_value)}/an</Pill>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                      {o.priority_label && <Pill tone={PRIORITY_TONES[o.priority_label]}>{o.priority_label}</Pill>}
                      <Pill tone="info">{CATEGORY_OPP_LABELS[o.category] ?? o.category}</Pill>
                      <span className="text-muted">
                        Effort {EFFORT_LABELS[o.effort]?.toLowerCase()} · payback {months(o.roi.payback_months)} · {o.target_delivery}
                      </span>
                      <ConfidenceBadge value={o.confidence} />
                      {o.validation_status !== "a_verifier" && <StatusBadge value={o.validation_status} />}
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base" data-testid="opp-table">
                  <thead>
                    <tr>
                      <th>Opportunité</th>
                      <th className="text-right">Valeur</th>
                      <th>Effort</th>
                      <th className="text-right">Payback</th>
                      <th className="text-right">Score</th>
                      <th>Priorité</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((o) => (
                      <tr key={o.id} className={clsx(o.validation_status === "rejete" && "opacity-50")}>
                        <td>
                          <Link className="font-semibold hover:text-info" href={`${base}/opportunities/${o.id}`}>
                            {o.title}
                          </Link>
                          <div className="text-xs text-muted">{CATEGORY_OPP_LABELS[o.category]}</div>
                        </td>
                        <td className="whitespace-nowrap text-right font-bold">{mad(o.roi.gross_annual_value)}</td>
                        <td>{EFFORT_LABELS[o.effort]}</td>
                        <td className="whitespace-nowrap text-right">{months(o.roi.payback_months)}</td>
                        <td className="text-right">{o.priority_score.toFixed(1)}</td>
                        <td>{o.priority_label ? <Pill tone={PRIORITY_TONES[o.priority_label]}>{o.priority_label}</Pill> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="xl:sticky xl:top-4 xl:self-start">
            <h2 className="mb-2 text-[15px] font-bold">Matrice impact / effort</h2>
            <ImpactEffortMatrix items={active} />
          </div>
        </div>
      )}
    </>
  );
}
