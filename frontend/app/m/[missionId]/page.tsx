"use client";

import useSWR from "swr";
import { useMission } from "@/components/shell/MissionContext";
import { Card, Empty, PageHeader, Pill, Stat } from "@/components/ui";
import { mad } from "@/lib/format";
import { STATUS_LABELS } from "@/lib/labels";
import type { MissionStats } from "@/lib/types";

export default function OverviewPage() {
  const { mission, organization } = useMission();
  const { data: stats } = useSWR<MissionStats>(`/missions/${mission.id}/stats`);
  const [statusLabel, statusTone] = STATUS_LABELS[mission.status];
  const desc = [organization.sector, organization.employees && `${organization.employees} collaborateurs`, organization.city].filter(Boolean).join(" — ");

  return (
    <>
      <PageHeader eyebrow="Audit IA & Performance" title={organization.name} subtitle={desc} actions={<Pill tone={statusTone}>{statusLabel}</Pill>} />
      <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <Stat label="Valeur annuelle identifiée" value={mad(stats?.annual_value_mad || null)} hint="Potentiel brut, hypothèses modifiables" tone="value" />
        <Stat label="Opportunités" value={stats?.opportunities ?? "—"} hint={`${stats?.opportunities_priority ?? 0} prioritaires`} />
        <Stat label="Irritants" value={stats?.pain_points ?? "—"} hint={`${stats?.pain_points_critical ?? 0} critiques`} />
        <Stat label="Sources" value={stats?.documents ?? "—"} hint={`${stats?.documents_indexed ?? 0} indexées`} />
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
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
        </Card>
      </div>
    </>
  );
}
