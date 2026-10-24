"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Sparkles } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { AnalyzeButton } from "@/components/AnalyzeButton";
import { CriticalityBadge } from "@/components/findings/Badges";
import { useMission } from "@/components/shell/MissionContext";
import { Bar, Card, Empty, PageHeader, Pill, Stat } from "@/components/ui";
import { mad, pct } from "@/lib/format";
import { AI_CATEGORY_KEYS, EFFORT_LABELS, PRIORITY_TONES, STATUS_LABELS } from "@/lib/labels";
import type { MissionStats, Overview } from "@/lib/types";

export default function OverviewPage() {
  const { mission, organization, base, canWrite } = useMission();
  const { data: stats } = useSWR<MissionStats>(`/missions/${mission.id}/stats`);
  const { data: ov } = useSWR<Overview>(`/missions/${mission.id}/overview`);
  const [statusLabel, statusTone] = STATUS_LABELS[mission.status];
  const desc = [organization.sector, organization.employees && `${organization.employees} collaborateurs`, organization.city].filter(Boolean).join(" — ");
  const analyzed = mission.analysis_version > 0;

  return (
    <>
      <PageHeader
        eyebrow="Audit IA & Performance"
        title={organization.name}
        subtitle={desc}
        actions={
          <>
            <Pill tone={statusTone}>{statusLabel}</Pill>
            {analyzed && (
              <Link href={`${base}/report`} className="inline-flex items-center rounded-lg border border-info bg-info px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700">
                Préparer la restitution
              </Link>
            )}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <Stat label="Valeur annuelle identifiée" value={mad(stats?.annual_value_mad || null)} hint="Potentiel brut, hypothèses modifiables" tone="value" />
        <Stat label="Opportunités" value={stats?.opportunities ?? "—"} hint={`${stats?.opportunities_priority ?? 0} prioritaires`} />
        <Stat label="Irritants" value={stats?.pain_points ?? "—"} hint={`${stats?.pain_points_critical ?? 0} critiques`} />
        <Stat label="Confiance analyse" value={stats?.analysis_confidence ? pct(stats.analysis_confidence) : "—"} hint={`${stats?.documents_indexed ?? 0} sources exploitables`} />
      </div>

      {!analyzed ? (
        <div className="mt-5 space-y-3">
          <Empty title="Analyse non lancée">Importez les sources (onglet Mission) puis lancez l&apos;analyse pour obtenir le diagnostic.</Empty>
          {canWrite && stats?.documents ? <AnalyzeButton /> : null}
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <Card title="Top opportunités" action={<Link href={`${base}/opportunities`} className="text-xs text-info hover:underline">Tout voir →</Link>}>
              <div className="space-y-2" data-testid="top-opportunities">
                {ov?.top_opportunities.map((o) => (
                  <Link key={o.id} href={`${base}/opportunities/${o.id}`} className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-xl border border-line p-3 hover:border-info">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 truncate font-semibold">
                        {AI_CATEGORY_KEYS.has(o.category) && <Sparkles size={13} className="text-info" />}
                        {o.title}
                      </div>
                      <div className="text-xs text-muted">
                        {o.pain_points[0]?.title ?? ""} · effort {EFFORT_LABELS[o.effort]?.toLowerCase()}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {o.priority_label && <Pill tone={PRIORITY_TONES[o.priority_label]}>{o.priority_label}</Pill>}
                      <Pill tone="value">{mad(o.roi.gross_annual_value)}</Pill>
                    </div>
                  </Link>
                ))}
              </div>
            </Card>
            <Card title="Maturité opérationnelle">
              <div className="space-y-3" data-testid="maturity">
                {ov?.maturity.map((m) => (
                  <div key={m.key} title={m.explanation}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="text-muted">{m.label}</span>
                      <b>{pct(m.value, 0)}</b>
                    </div>
                    <Bar value={m.value} tone={m.value >= 0.6 ? "value" : m.value >= 0.4 ? "info" : "check"} />
                    <div className="mt-1 text-[11px] leading-snug text-muted">{m.inputs.map((i) => `${i.label} ${pct(i.value, 0)}`).join(" · ")}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <Card title="Quick wins">
              {ov?.quick_wins.length ? (
                <ul className="space-y-2 text-sm">
                  {ov.quick_wins.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2">
                      <Link href={`${base}/opportunities/${o.id}`} className="truncate hover:text-info">
                        {o.title}
                      </Link>
                      <span className="shrink-0 text-xs text-muted">{o.target_delivery}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-muted">Aucun quick win identifié.</div>
              )}
            </Card>
            <Card title="Risques">
              <ul className="space-y-2 text-sm">
                {ov?.risks.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-2">
                    <span className="flex items-start gap-1.5">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-risk" /> {r.title}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      <CriticalityBadge value={r.severity} />
                      {r.exposure_mad_per_year ? <span className="text-[11px] text-muted">{mad(r.exposure_mad_per_year)}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
            <Card title={`Complétude des données — ${pct(ov?.completeness.score ?? 0, 0)}`}>
              <ul className="space-y-1.5 text-xs">
                {ov?.completeness.present.map((p) => (
                  <li key={p} className="flex items-center gap-1.5">
                    <CheckCircle2 size={13} className="text-value" /> {p}
                  </li>
                ))}
                {ov?.completeness.missing.map((p) => (
                  <li key={p} className="flex items-center gap-1.5 text-check">
                    <CircleDashed size={13} /> {p}
                  </li>
                ))}
              </ul>
              {ov?.completeness.gaps.length ? (
                <div className="mt-3 rounded-lg bg-check-soft p-2 text-[11px] text-check">
                  {ov.completeness.gaps.map((g) => (
                    <div key={g}>• {g}</div>
                  ))}
                </div>
              ) : null}
            </Card>
          </div>
        </>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
        <Card title="Objectifs de la direction">
          {mission.objectives.length ? (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {mission.objectives.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          ) : (
            <Empty title="Aucun objectif renseigné" />
          )}
        </Card>
        <Card title="Périmètre">
          <div className="flex flex-wrap gap-1.5">
            {mission.scope.map((s) => (
              <Pill key={s} tone="info">
                {s}
              </Pill>
            ))}
          </div>
          {canWrite && analyzed && (
            <div className="mt-4 border-t border-line pt-3">
              <AnalyzeButton label="Relancer l'analyse" variant="default" />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
