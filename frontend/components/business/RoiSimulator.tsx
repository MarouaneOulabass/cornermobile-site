"use client";

import clsx from "clsx";
import { FileSearch, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { mutate } from "swr";
import { EvidencePanel } from "@/components/evidence/EvidencePanel";
import { NatureBadge } from "@/components/findings/Badges";
import { useMission } from "@/components/shell/MissionContext";
import { Button, Drawer, ErrorBox, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { fromDisplay, toDisplay, unitLabel } from "@/lib/assumptions";
import { mad, months, num, pct } from "@/lib/format";
import type { Assumption, OpportunityDetail, SimulateResult } from "@/lib/types";

const GROUPS: [Assumption["group"], string][] = [
  ["actuel", "Situation actuelle"],
  ["cible", "Situation cible"],
  ["couts", "Coûts de la solution"],
];

const DERIVED = new Set(["per_period"]);

export function RoiSimulator({ opp, onSaved }: { opp: OpportunityDetail; onSaved: () => void }) {
  const { mission, canWrite } = useMission();
  const saved = useMemo(() => Object.fromEntries(opp.assumptions.map((a) => [a.key, a.value])), [opp.assumptions]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [evidenceFor, setEvidenceFor] = useState<Assumption | null>(null);

  const overrides = useMemo(() => {
    const out: Record<string, number> = {};
    for (const a of opp.assumptions) {
      if (draft[a.key] === undefined) continue;
      const v = fromDisplay(a, draft[a.key]);
      if (v !== null && v !== a.value) out[a.key] = v;
    }
    return out;
  }, [draft, opp.assumptions]);
  const dirty = Object.keys(overrides).length > 0;

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        setResult(await api.post<SimulateResult>(`/missions/${mission.id}/opportunities/${opp.id}/simulate`, { overrides }));
        setError(null);
      } catch (err) {
        setError(err);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [overrides, mission.id, opp.id]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      for (const [key, value] of Object.entries(overrides)) {
        const a = opp.assumptions.find((x) => x.key === key)!;
        await api.post(`/missions/${mission.id}/review/assumption/${a.id}`, { changes: { value }, comment: "Hypothèse ajustée dans le simulateur" });
      }
      setDraft({});
      await mutate((k) => typeof k === "string" && k.startsWith(`/missions/${mission.id}`));
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const r = result?.results ?? opp.roi;
  const lines = result?.lines ?? opp.lines;
  return (
    <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]" data-testid="roi-simulator">
      <div className="space-y-4">
      {GROUPS.map(([group, title]) => {
        const items = opp.assumptions.filter((a) => a.group === group && !DERIVED.has(a.key));
        if (!items.length) return null;
        return (
          <div key={group}>
            <div className="eyebrow mb-2">{title}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((a) => {
                const value = draft[a.key] ?? toDisplay(a, a.value);
                const changed = overrides[a.key] !== undefined;
                const edited = a.edited_fields.includes("value");
                return (
                  <label key={a.key} className={clsx("block rounded-xl border p-2.5", changed ? "border-check bg-check-soft/40" : "border-line")} title={a.source}>
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-xs font-medium leading-snug">{a.label}</span>
                      <NatureBadge nature={a.nature} />
                    </span>
                    <span className="mt-1.5 flex items-center gap-2">
                      <input
                        className="input py-1.5 text-right font-semibold"
                        inputMode="decimal"
                        value={value}
                        aria-label={a.label}
                        data-key={a.key}
                        onChange={(e) => setDraft({ ...draft, [a.key]: e.target.value })}
                      />
                      <span className="w-16 shrink-0 text-xs text-muted">{unitLabel(a)}</span>
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted">
                      <span className="line-clamp-2">{a.source}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        {edited && <Pill tone="info">ajustée</Pill>}
                        {a.evidence_count > 0 && (
                          <button type="button" className="inline-flex items-center gap-0.5 text-info hover:underline" onClick={(e) => { e.preventDefault(); setEvidenceFor(a); }}>
                            <FileSearch size={12} /> {a.evidence_count}
                          </button>
                        )}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
      </div>

      <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
      <div className="rounded-2xl border border-value/30 bg-value-soft/40 p-4" data-testid="roi-results">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[11px] text-muted">Heures économisées</div>
            <div className="text-lg font-extrabold">{num(r.hours_saved_month)} h/mois</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">Valeur annuelle brute</div>
            <div className="text-lg font-extrabold whitespace-nowrap text-value" data-testid="gross-value">{mad(r.gross_annual_value, { compact: false })}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">Gain net annuel</div>
            <div className="text-lg font-extrabold">{mad(r.net_annual_gain)}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">Payback</div>
            <div className="text-lg font-extrabold">{months(r.payback_months)}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">Coût projet</div>
            <div className="font-bold">{mad(r.project_cost)}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">Coût annuel de la solution</div>
            <div className="font-bold">{mad(r.annual_solution_cost)}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">ROI 12 mois</div>
            <div className="font-bold">{r.roi_12m === null ? "—" : pct(r.roi_12m, 0)}</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">ROI 36 mois</div>
            <div className="font-bold">{r.roi_36m === null ? "—" : pct(r.roi_36m, 0)}</div>
          </div>
        </div>
        <div className="mt-3 border-t border-value/20 pt-3">
          <div className="eyebrow mb-1">Décomposition</div>
          <ul className="space-y-1 text-xs">
            {lines.map((l) => (
              <li key={l.key} className="flex justify-between gap-2">
                <span>
                  {l.label}
                  {l.hours_month ? <span className="text-muted"> · {num(l.hours_month, 1)} h/mois</span> : null}
                </span>
                <b>{mad(l.annual_value)}/an</b>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        {canWrite && (
          <Button variant="primary" onClick={save} disabled={!dirty || saving}>
            <Save size={14} /> {saving ? "Enregistrement…" : "Enregistrer les hypothèses"}
          </Button>
        )}
        <Button onClick={() => setDraft({})} disabled={!dirty}>
          <RotateCcw size={14} /> Réinitialiser
        </Button>
      </div>
      <div className="text-xs text-muted">
        {dirty ? `${Object.keys(overrides).length} hypothèse(s) modifiée(s) — simulation en direct, non enregistrée` : "Modifiez une hypothèse : le ROI est recalculé instantanément."}
      </div>
      </div>
      <Drawer open={!!evidenceFor} onClose={() => setEvidenceFor(null)} title={evidenceFor?.label ?? ""} width="max-w-2xl">
        {evidenceFor && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <b className="text-xl">{toDisplay(evidenceFor, saved[evidenceFor.key])} {unitLabel(evidenceFor)}</b>
              <NatureBadge nature={evidenceFor.nature} />
            </div>
            <p className="text-muted">{evidenceFor.source}</p>
            <EvidencePanel missionId={mission.id} targetType="assumption" targetId={evidenceFor.id} />
          </div>
        )}
      </Drawer>
    </div>
  );
}
