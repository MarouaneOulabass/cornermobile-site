"use client";

import { ArrowRight, Check, Sparkles } from "lucide-react";
import Link from "next/link";
import { use, useState } from "react";
import useSWR, { mutate } from "swr";
import { RoiSimulator } from "@/components/business/RoiSimulator";
import { ScoreBreakdown } from "@/components/business/ScoreBreakdown";
import { EvidencePanel } from "@/components/evidence/EvidencePanel";
import { ConfidenceBadge, CriticalityBadge, HypothesisBadge, StatusBadge } from "@/components/findings/Badges";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { useMission } from "@/components/shell/MissionContext";
import { Button, Card, ErrorBox, Loading, PageHeader, Pill, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import { mad, months } from "@/lib/format";
import { AI_CATEGORY_KEYS, CATEGORY_OPP_LABELS, EFFORT_LABELS, PRIORITY_TONES } from "@/lib/labels";
import type { OpportunityDetail } from "@/lib/types";

export default function BusinessCasePage({ params }: { params: Promise<{ oppId: string }> }) {
  const { oppId } = use(params);
  const { mission, base, canWrite } = useMission();
  const key = `/missions/${mission.id}/opportunities/${oppId}`;
  const { data: opp, error, mutate: reload } = useSWR<OpportunityDetail>(key);
  const [actionError, setActionError] = useState<unknown>(null);

  if (error) return <ErrorBox error={error} />;
  if (!opp) return <Loading />;

  async function validate() {
    setActionError(null);
    try {
      await api.post(`/missions/${mission.id}/review/opportunity/${opp!.id}`, { status: "valide", comment: "Business case validé" });
      await reload();
      mutate(`/missions/${mission.id}/opportunities?sort=priority`);
    } catch (err) {
      setActionError(err);
    }
  }

  const ai = AI_CATEGORY_KEYS.has(opp.category);
  const totalWeeks = opp.pilot_plan.reduce((s, p) => s + p.weeks, 0);

  return (
    <>
      <Link href={`${base}/opportunities`} className="text-sm text-info hover:underline">
        ← Opportunités
      </Link>
      <PageHeader
        eyebrow="Business case"
        title={
          <span className="flex items-center gap-2">
            {ai && <Sparkles className="text-info" size={22} />}
            {opp.title}
          </span>
        }
        subtitle={opp.summary}
        actions={
          <>
            {opp.priority_label && <Pill tone={PRIORITY_TONES[opp.priority_label]}>{opp.priority_label} · rang {opp.priority_rank}</Pill>}
            <StatusBadge value={opp.validation_status} />
            {canWrite && opp.validation_status !== "valide" && (
              <Button onClick={validate}>
                <Check size={14} /> Marquer comme validé
              </Button>
            )}
          </>
        }
      />
      {actionError ? <ErrorBox error={actionError} /> : null}
      <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <Stat label="Valeur annuelle" value={mad(opp.roi.gross_annual_value)} hint="brute, avant coûts" tone="value" />
        <Stat label="Payback" value={months(opp.roi.payback_months)} hint={`gain net ${mad(opp.roi.net_annual_gain)}/an`} />
        <Stat label="Effort" value={EFFORT_LABELS[opp.effort]} hint={`livraison ${opp.target_delivery}`} />
        <Stat label="Confiance" value={`${Math.round(opp.confidence * 100)} %`} hint="preuves × part de faits dans les hypothèses" />
      </div>

      <Card title="Simulateur ROI" className="mt-5">
        <RoiSimulator key={opp.assumptions.map((a) => `${a.key}:${a.value}`).join("|")} opp={opp} onSaved={() => reload()} />
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <Card title="Pourquoi cette recommandation ?">
            <div className="mb-3 space-y-2">
              {opp.pain_points.map((p) => (
                <Link key={p.id} href={`${base}/pain-points`} className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm hover:bg-info-soft">
                  <span className="min-w-0 truncate">{p.title}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <CriticalityBadge value={p.criticality} />
                    {p.is_hypothesis && <HypothesisBadge />}
                  </span>
                </Link>
              ))}
            </div>
            <EvidencePanel missionId={mission.id} targetType="opportunity" targetId={opp.id} />
          </Card>
          <Card title="Pourquoi cette catégorie ?">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={ai ? "info" : "value"}>{CATEGORY_OPP_LABELS[opp.category]}</Pill>
              <ConfidenceBadge value={opp.confidence} />
            </div>
            <p className="mt-2 text-sm text-gray-700">{opp.category_rationale}</p>
          </Card>
          <Card title="Architecture cible">
            <ol className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="architecture">
              {opp.architecture.map((c, i) => (
                <li key={c} className="flex items-center gap-1.5">
                  <span className="rounded-lg border border-line bg-white px-2.5 py-1.5 font-medium">{c}</span>
                  {i < opp.architecture.length - 1 && <ArrowRight size={12} className="text-muted" />}
                </li>
              ))}
            </ol>
          </Card>
          <Card title={`Plan pilote — ${totalWeeks} semaines`}>
            <div className="space-y-1.5" data-testid="pilot-plan">
              {opp.pilot_plan.map((p, i) => {
                const offset = opp.pilot_plan.slice(0, i).reduce((s, x) => s + x.weeks, 0);
                return (
                  <div key={p.step} className="grid grid-cols-[1fr_2fr] items-center gap-2 text-xs">
                    <span className="truncate">{p.step}</span>
                    <span className="relative h-5 rounded bg-gray-100">
                      <span className="absolute inset-y-0 rounded bg-info/80 px-1.5 text-[10px] leading-5 text-white" style={{ left: `${(offset / totalWeeks) * 100}%`, width: `${(p.weeks / totalWeeks) * 100}%` }}>
                        {p.weeks} sem.
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
            {opp.kpis.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <div className="eyebrow mb-1.5">Indicateurs de suivi</div>
                <div className="flex flex-wrap gap-1.5">
                  {opp.kpis.map((k) => (
                    <Pill key={k}>{k}</Pill>
                  ))}
                </div>
              </div>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="Comment la priorité est calculée">
            <ScoreBreakdown scores={opp.scores} weights={opp.weights} penalties={opp.penalties} priority={opp.priority_score} />
          </Card>
          <Card title="Validation">
            <ReviewPanel targetType="opportunity" targetId={opp.id} status={opp.validation_status} onChanged={() => reload()} />
          </Card>
        </div>
      </div>
    </>
  );
}
