"use client";

import clsx from "clsx";
import { useState } from "react";
import useSWR from "swr";
import { EvidencePanel } from "@/components/evidence/EvidencePanel";
import { BusinessGraph } from "@/components/graph/BusinessGraph";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { useMission } from "@/components/shell/MissionContext";
import { Button, Drawer, Empty, ErrorBox, Loading, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { num } from "@/lib/format";
import { VALIDATION_LABELS } from "@/lib/labels";
import type { Process } from "@/lib/types";

function duration(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 120) return `${num(minutes)} min`;
  if (minutes < 60 * 48) return `${num(minutes / 60, 1)} h`;
  return `${num(minutes / 60 / 24, 1)} j`;
}

function ProcessEditor({ proc, onSaved }: { proc: Process; onSaved: () => void }) {
  const { mission } = useMission();
  const [form, setForm] = useState({ owner_department: proc.owner_department ?? "", description: proc.description ?? "", tools: proc.tools.join(", ") });
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setError(null);
    try {
      await api.post(`/missions/${mission.id}/review/process/${proc.id}`, {
        changes: {
          owner_department: form.owner_department || null,
          description: form.description,
          tools: form.tools.split(",").map((t) => t.trim()).filter(Boolean),
        },
      });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <div className="eyebrow">Corriger</div>
      <label className="block">
        <span className="label">Propriétaire</span>
        <input className="input" value={form.owner_department} onChange={(e) => setForm({ ...form, owner_department: e.target.value })} />
      </label>
      <label className="block">
        <span className="label">Outils (séparés par des virgules)</span>
        <input className="input" value={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.value })} />
      </label>
      <label className="block">
        <span className="label">Description</span>
        <textarea className="input min-h-16" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      {error ? <ErrorBox error={error} /> : null}
      <Button size="sm" variant="primary" onClick={save}>
        Enregistrer la correction
      </Button>
    </div>
  );
}

function ProcessDetail({ proc, onChanged }: { proc: Process; onChanged: () => void }) {
  const { mission, canWrite } = useMission();
  return (
    <div className="space-y-5 text-sm">
      <p className="text-gray-700">{proc.description}</p>
      <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-xs">
        <dt className="text-muted">Propriétaire</dt>
        <dd>{proc.owner_department ?? <span className="text-check">non défini {proc.owner_defined ? "" : "(la procédure ne le précise pas)"}</span>}</dd>
        <dt className="text-muted">Outils</dt>
        <dd className="flex flex-wrap gap-1">{proc.tools.length ? proc.tools.map((t) => <Pill key={t}>{t}</Pill>) : "—"}</dd>
        <dt className="text-muted">Entrées</dt>
        <dd>{proc.inputs.join(", ") || "—"}</dd>
        <dt className="text-muted">Sorties</dt>
        <dd>{proc.outputs.join(", ") || "—"}</dd>
        <dt className="text-muted">Temps de cycle</dt>
        <dd>{duration(proc.cycle_time_minutes)} {proc.cycle_time_minutes !== null && <span className="text-muted">(médiane observée)</span>}</dd>
        <dt className="text-muted">Confiance</dt>
        <dd>{Math.round(proc.confidence * 100)} %</dd>
      </dl>
      {proc.steps.length > 0 && (
        <div>
          <div className="eyebrow mb-2">Étapes (procédure documentée)</div>
          <ol className="space-y-1.5">
            {proc.steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5 text-xs">
                <span className="font-bold text-muted">{s.ordinal}.</span>
                <span className="flex-1">{s.label}</span>
                <span className="flex shrink-0 gap-1">
                  {s.is_reentry && <Pill tone="risk">ressaisie</Pill>}
                  {s.is_manual && !s.is_reentry && <Pill tone="check">manuel</Pill>}
                  {s.requires_validation && <Pill tone="info">validation</Pill>}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div>
        <div className="eyebrow mb-2">Preuves</div>
        <EvidencePanel missionId={mission.id} targetType="process" targetId={proc.id} />
      </div>
      {canWrite && <ProcessEditor key={proc.id + proc.edited_fields.join()} proc={proc} onSaved={onChanged} />}
      <ReviewPanel targetType="process" targetId={proc.id} status={proc.validation_status} onChanged={onChanged} />
    </div>
  );
}

export default function ProcessesPage() {
  const { mission } = useMission();
  const [tab, setTab] = useState<"list" | "map">("list");
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, mutate } = useSWR<Process[]>(`/missions/${mission.id}/processes`);
  const open = data?.find((p) => p.id === openId);

  return (
    <>
      <PageHeader eyebrow="Cartographie" title="Processus" subtitle="Vue reconstruite automatiquement à partir des procédures et des données, puis validée par le consultant." />
      <div className="mb-4 inline-flex rounded-lg border border-line bg-white p-0.5 text-sm" role="tablist">
        {(["list", "map"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={clsx("rounded-md px-3 py-1.5 font-semibold", tab === t ? "bg-info text-white" : "text-muted hover:text-ink")}>
            {t === "list" ? "Liste" : "Business graph"}
          </button>
        ))}
      </div>
      {tab === "map" ? (
        <BusinessGraph />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="Aucun processus">Importez les sources puis lancez l&apos;analyse.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table-base" data-testid="process-table">
            <thead>
              <tr>
                <th>Processus</th>
                <th>Équipe</th>
                <th>Outils</th>
                <th>Temps de cycle</th>
                <th>Irritants</th>
                <th>Confiance</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => {
                const [label, tone] = VALIDATION_LABELS[p.validation_status];
                return (
                  <tr key={p.id} className="cursor-pointer hover:bg-gray-50" onClick={() => setOpenId(p.id)}>
                    <td>
                      <div className="font-semibold">{p.name}</div>
                      <div className="text-xs text-muted">{p.steps.length ? "Procédure documentée" : "Reconstitué des données"}</div>
                    </td>
                    <td>{p.owner_department ?? <span className="text-check">non défini</span>}</td>
                    <td className="max-w-56 text-xs">{p.tools.join(", ") || "—"}</td>
                    <td>{duration(p.cycle_time_minutes)}</td>
                    <td>
                      {p.pain_points ? <Pill tone={p.pain_points_critical ? "risk" : "check"}>{p.pain_points_critical ? `${p.pain_points_critical} critique(s)` : `${p.pain_points} point(s)`}</Pill> : <span className="text-muted">—</span>}
                    </td>
                    <td>{Math.round(p.confidence * 100)} %</td>
                    <td>
                      <Pill tone={tone}>{label}</Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Drawer open={!!open} onClose={() => setOpenId(null)} title={open?.name ?? "Processus"} width="max-w-2xl">
        {open && <ProcessDetail proc={open} onChanged={() => mutate()} />}
      </Drawer>
    </>
  );
}
