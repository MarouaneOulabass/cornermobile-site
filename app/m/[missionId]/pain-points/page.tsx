"use client";

import { useState } from "react";
import useSWR from "swr";
import { CriticalityBadge, HypothesisBadge, StatusBadge } from "@/components/findings/Badges";
import { PainDetail } from "@/components/findings/PainDetail";
import { useMission } from "@/components/shell/MissionContext";
import { Drawer, Empty, Loading, PageHeader, Pill, Stat } from "@/components/ui";
import { mad } from "@/lib/format";
import { CRITICALITY_LABELS, PAIN_TYPE_LABELS, VALIDATION_LABELS } from "@/lib/labels";
import type { PainPoint } from "@/lib/types";

export default function PainPointsPage() {
  const { mission } = useMission();
  const [filters, setFilters] = useState({ department: "", criticality: "", type: "", min_confidence: "", status: "" });
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: all } = useSWR<PainPoint[]>(`/missions/${mission.id}/pain-points`);
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const { data, mutate } = useSWR<PainPoint[]>(`/missions/${mission.id}/pain-points${query ? `?${query}` : ""}`);
  const open = data?.find((p) => p.id === openId) ?? all?.find((p) => p.id === openId);
  const departments = [...new Set((all ?? []).map((p) => p.department).filter(Boolean))] as string[];
  const types = [...new Set((all ?? []).map((p) => p.type))];
  const set = (k: keyof typeof filters) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <>
      <PageHeader eyebrow="Constats" title="Irritants détectés" subtitle="Chaque constat est relié à ses preuves : lignes de données, extraits de documents et calculs. Les hypothèses sont signalées comme telles." />
      <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <Stat label="Irritants" value={all?.length ?? "—"} hint={`${departments.length} départements concernés`} />
        <Stat label="Critiques" value={all?.filter((p) => p.criticality === "critique").length ?? "—"} tone="risk" hint="à traiter en priorité" />
        <Stat label="Hypothèses à valider" value={all?.filter((p) => p.is_hypothesis).length ?? "—"} hint="sans preuve directe" />
        <Stat label="Revus" value={all?.filter((p) => p.validation_status !== "a_verifier").length ?? "—"} hint="validés, corrigés ou rejetés" tone="value" />
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <select className="input w-auto" value={filters.department} onChange={set("department")} aria-label="Département">
          <option value="">Tous départements</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select className="input w-auto" value={filters.criticality} onChange={set("criticality")} aria-label="Criticité">
          <option value="">Toutes criticités</option>
          {Object.entries(CRITICALITY_LABELS).map(([k, [v]]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={filters.type} onChange={set("type")} aria-label="Type">
          <option value="">Tous types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {PAIN_TYPE_LABELS[t] ?? t}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={filters.min_confidence} onChange={set("min_confidence")} aria-label="Confiance minimale">
          <option value="">Toute confiance</option>
          <option value="0.6">≥ 60 %</option>
          <option value="0.8">≥ 80 %</option>
        </select>
        <select className="input w-auto" value={filters.status} onChange={set("status")} aria-label="Statut">
          <option value="">Tous statuts</option>
          {Object.entries(VALIDATION_LABELS).map(([k, [v]]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-4 space-y-2.5" data-testid="pain-list">
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <Empty title="Aucun irritant">{all?.length ? "Aucun irritant ne correspond aux filtres." : "Lancez l'analyse depuis l'onglet Mission."}</Empty>
        ) : (
          data.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => setOpenId(p.id)}
              className={`grid w-full grid-cols-[1fr_auto] gap-3 rounded-xl border bg-white p-3.5 text-left transition hover:border-info ${p.validation_status === "rejete" ? "border-line opacity-60" : "border-line"}`}
            >
              <div className="min-w-0">
                <div className="font-semibold">{p.title}</div>
                <div className="mt-0.5 line-clamp-2 text-xs text-muted">{p.description}</div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  <Pill tone="info">{PAIN_TYPE_LABELS[p.type] ?? p.type}</Pill>
                  <span className="text-muted">
                    {p.department ?? "Transverse"} · {p.sources} source(s) convergente(s) · confiance {Math.round(p.confidence * 100)} %
                  </span>
                  {p.is_hypothesis && <HypothesisBadge />}
                  {p.impact_mad_per_year ? <Pill title="Impact annuel estimé (voir hypothèses)">impact {mad(p.impact_mad_per_year)}/an</Pill> : null}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <CriticalityBadge value={p.criticality} />
                <StatusBadge value={p.validation_status} />
              </div>
            </button>
          ))
        )}
      </div>
      <Drawer open={!!open} onClose={() => setOpenId(null)} title={open?.title ?? "Irritant"} width="max-w-2xl">
        {open && <PainDetail pp={open} onChanged={() => mutate()} />}
      </Drawer>
    </>
  );
}
