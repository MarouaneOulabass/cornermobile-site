"use client";

import { useState } from "react";
import { EvidencePanel } from "@/components/evidence/EvidencePanel";
import { ConfidenceBadge, CriticalityBadge, HypothesisBadge, StatusBadge } from "@/components/findings/Badges";
import { MetricTable } from "@/components/findings/MetricTable";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { useMission } from "@/components/shell/MissionContext";
import { Button, ErrorBox, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { mad } from "@/lib/format";
import { CRITICALITY_LABELS, PAIN_TYPE_LABELS } from "@/lib/labels";
import type { PainPoint } from "@/lib/types";

function PainEditor({ pp, onSaved }: { pp: PainPoint; onSaved: () => void }) {
  const { mission } = useMission();
  const [form, setForm] = useState({ title: pp.title, criticality: pp.criticality, description: pp.description, department: pp.department ?? "" });
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setError(null);
    try {
      await api.post(`/missions/${mission.id}/review/pain_point/${pp.id}`, {
        changes: { title: form.title, criticality: form.criticality, description: form.description, department: form.department || null },
      });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <div className="eyebrow">Corriger</div>
      <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} aria-label="Titre" />
      <div className="grid grid-cols-2 gap-2">
        <select className="input" value={form.criticality} onChange={(e) => setForm({ ...form, criticality: e.target.value })} aria-label="Criticité">
          {Object.entries(CRITICALITY_LABELS).map(([k, [v]]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input className="input" placeholder="Département" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} aria-label="Département" />
      </div>
      <textarea className="input min-h-24" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} aria-label="Description" />
      {error ? <ErrorBox error={error} /> : null}
      <Button size="sm" variant="primary" onClick={save}>
        Enregistrer la correction
      </Button>
    </div>
  );
}

export function PainDetail({ pp, onChanged }: { pp: PainPoint; onChanged: () => void }) {
  const { mission, canWrite, base } = useMission();
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap gap-1.5">
        <CriticalityBadge value={pp.criticality} />
        <Pill tone="info">{PAIN_TYPE_LABELS[pp.type] ?? pp.type}</Pill>
        <ConfidenceBadge value={pp.confidence} />
        {pp.is_hypothesis && <HypothesisBadge />}
        <StatusBadge value={pp.validation_status} />
      </div>
      <p className="leading-relaxed text-gray-800">{pp.description}</p>
      <dl className="grid grid-cols-[130px_1fr] gap-y-1.5 text-xs">
        <dt className="text-muted">Périmètre</dt>
        <dd>{pp.scope ?? "—"}</dd>
        <dt className="text-muted">Département</dt>
        <dd>{pp.department ?? "Transverse"}</dd>
        <dt className="text-muted">Processus</dt>
        <dd>{pp.process_name ?? "—"}</dd>
        <dt className="text-muted">Fréquence</dt>
        <dd>{pp.frequency ?? "—"}</dd>
        <dt className="text-muted">Impact</dt>
        <dd>{pp.impact ?? "Non chiffrable avec les sources disponibles"}</dd>
      </dl>
      {pp.metrics.length > 0 && (
        <div>
          <div className="eyebrow mb-2">Chiffres (cliquez pour la provenance)</div>
          <MetricTable metrics={pp.metrics} />
        </div>
      )}
      {pp.risk && (
        <div className="rounded-xl border border-risk/30 bg-risk-soft/40 p-3 text-xs">
          <div className="flex items-center justify-between">
            <b className="text-risk">Risque : {pp.risk.title}</b>
            {pp.risk.exposure_mad_per_year ? <span className="font-bold">{mad(pp.risk.exposure_mad_per_year)}</span> : null}
          </div>
          <div className="mt-1">{pp.risk.description}</div>
        </div>
      )}
      <div>
        <div className="eyebrow mb-2">Preuves ({pp.evidence_count} extraits, {pp.sources} source(s))</div>
        <EvidencePanel missionId={mission.id} targetType="pain_point" targetId={pp.id} />
      </div>
      {pp.opportunity_ids.length > 0 && (
        <div className="text-xs">
          <a className="text-info hover:underline" href={`${base}/opportunities/${pp.opportunity_ids[0]}`}>
            → Voir l&apos;opportunité associée
          </a>
        </div>
      )}
      {canWrite && <PainEditor key={pp.id + pp.edited_fields.join()} pp={pp} onSaved={onChanged} />}
      <ReviewPanel targetType="pain_point" targetId={pp.id} status={pp.validation_status} onChanged={onChanged} />
    </div>
  );
}

