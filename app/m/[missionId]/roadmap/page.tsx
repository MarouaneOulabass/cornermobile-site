"use client";

import clsx from "clsx";
import { GripVertical, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { StatusBadge } from "@/components/findings/Badges";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { useMission } from "@/components/shell/MissionContext";
import { Button, Card, Drawer, Empty, ErrorBox, Loading, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { mad } from "@/lib/format";
import { PRIORITY_TONES, ROADMAP_KINDS } from "@/lib/labels";
import type { Roadmap, RoadmapItem } from "@/lib/types";

const NINETY = ["j30", "j60", "j90"];
const SHORT: Record<string, string> = { j30: "J0–30", j60: "J30–60", j90: "J60–90", t2: "Mois 4–6", t3: "Mois 7–9", t4: "Mois 10–12" };

function ItemCard({ item, onOpen, draggable }: { item: RoadmapItem; onOpen: () => void; draggable: boolean }) {
  const kind = ROADMAP_KINDS[item.kind];
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData("text/plain", item.id)}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={clsx("cursor-pointer rounded-xl border border-line bg-white p-2.5 text-sm transition hover:border-info", item.validation_status === "rejete" && "opacity-50")}
      data-testid="roadmap-card"
    >
      <div className="flex items-start gap-1.5">
        {draggable && <GripVertical size={14} className="mt-0.5 shrink-0 text-gray-300" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug">{item.title}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
            <Pill tone={kind.tone}>{kind.label}</Pill>
            {item.priority_label && <Pill tone={PRIORITY_TONES[item.priority_label]}>{item.priority_label}</Pill>}
            <span className="text-muted">
              S{item.start_week + 1}–S{item.start_week + item.duration_weeks} · {item.owner ?? "à désigner"}
            </span>
          </div>
          {item.value ? <div className="mt-1 text-[11px] font-semibold text-value">{mad(item.value)}/an</div> : null}
        </div>
      </div>
    </div>
  );
}

function Gantt({ data, onOpen }: { data: Roadmap; onOpen: (i: RoadmapItem) => void }) {
  const weeks = 52;
  return (
    <div className="card overflow-x-auto p-0" data-testid="gantt">
      <div className="min-w-[860px]">
        <div className="grid grid-cols-[260px_1fr] border-b border-line text-[11px] text-muted">
          <div className="px-3 py-2 font-semibold">Chantier</div>
          <div className="relative h-8">
            {data.phases.map((p) => (
              <div key={p.key} className={clsx("absolute inset-y-0 overflow-hidden whitespace-nowrap border-l border-line px-1.5 py-2", NINETY.includes(p.key) && "bg-info-soft/40")} style={{ left: `${(p.start_week / weeks) * 100}%`, width: `${((p.end_week - p.start_week + 1) / weeks) * 100}%` }}>
                {SHORT[p.key] ?? p.label}
              </div>
            ))}
          </div>
        </div>
        {data.items.map((item) => (
          <div key={item.id} className="grid grid-cols-[260px_1fr] border-b border-line last:border-0 hover:bg-gray-50">
            <button type="button" onClick={() => onOpen(item)} className="truncate px-3 py-2 text-left text-xs font-medium hover:text-info" title={item.title}>
              {item.title}
            </button>
            <div className="relative h-9">
              <button
                type="button"
                onClick={() => onOpen(item)}
                className="absolute top-1.5 h-6 rounded-md px-1.5 text-left text-[10px] font-semibold text-white"
                style={{
                  left: `${(item.start_week / weeks) * 100}%`,
                  width: `${(Math.min(item.duration_weeks, weeks - item.start_week) / weeks) * 100}%`,
                  background: ROADMAP_KINDS[item.kind].color,
                  opacity: item.validation_status === "rejete" ? 0.35 : 1,
                }}
                title={`${item.title} — S${item.start_week + 1} à S${item.start_week + item.duration_weeks}`}
              >
                <span className="block truncate leading-6">{item.duration_weeks} sem.</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemEditor({ item, onSaved }: { item: RoadmapItem; onSaved: () => void }) {
  const { mission } = useMission();
  const [form, setForm] = useState({ start_week: item.start_week + 1, duration_weeks: item.duration_weeks, owner: item.owner ?? "" });
  const [error, setError] = useState<unknown>(null);
  async function save() {
    setError(null);
    try {
      await api.post(`/missions/${mission.id}/review/roadmap_item/${item.id}`, {
        changes: { start_week: Number(form.start_week) - 1, duration_weeks: Number(form.duration_weeks), owner: form.owner || null },
      });
      onSaved();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="space-y-2 rounded-xl border border-line p-3">
      <div className="eyebrow">Replanifier</div>
      <div className="grid grid-cols-3 gap-2">
        <label>
          <span className="label">Semaine de début</span>
          <input className="input" type="number" min={1} max={104} value={form.start_week} onChange={(e) => setForm({ ...form, start_week: Number(e.target.value) })} />
        </label>
        <label>
          <span className="label">Durée (sem.)</span>
          <input className="input" type="number" min={1} max={104} value={form.duration_weeks} onChange={(e) => setForm({ ...form, duration_weeks: Number(e.target.value) })} />
        </label>
        <label>
          <span className="label">Responsable</span>
          <input className="input" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
        </label>
      </div>
      {error ? <ErrorBox error={error} /> : null}
      <Button size="sm" variant="primary" onClick={save}>
        Enregistrer
      </Button>
    </div>
  );
}

function NewItem({ onCreated }: { onCreated: () => void }) {
  const { mission } = useMission();
  const [form, setForm] = useState({ title: "", phase: "j30", duration_weeks: 2, owner: "" });
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="card grid gap-2 sm:grid-cols-[2fr_1fr_100px_1fr_auto] sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api.post(`/missions/${mission.id}/roadmap`, { ...form, owner: form.owner || null });
          setForm({ ...form, title: "" });
          onCreated();
        } catch (err) {
          setError(err);
        }
      }}
    >
      <label>
        <span className="label">Nouveau chantier</span>
        <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required minLength={2} />
      </label>
      <label>
        <span className="label">Phase</span>
        <select className="input" value={form.phase} onChange={(e) => setForm({ ...form, phase: e.target.value })}>
          <option value="j30">0–30 jours</option>
          <option value="j60">30–60 jours</option>
          <option value="j90">60–90 jours</option>
          <option value="t2">Mois 4–6</option>
          <option value="t3">Mois 7–9</option>
          <option value="t4">Mois 10–12</option>
        </select>
      </label>
      <label>
        <span className="label">Durée</span>
        <input className="input" type="number" min={1} value={form.duration_weeks} onChange={(e) => setForm({ ...form, duration_weeks: Number(e.target.value) })} />
      </label>
      <label>
        <span className="label">Responsable</span>
        <input className="input" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
      </label>
      <Button type="submit">
        <Plus size={14} /> Ajouter
      </Button>
      {error ? <div className="sm:col-span-5"><ErrorBox error={error} /></div> : null}
    </form>
  );
}

export default function RoadmapPage() {
  const { mission, canWrite, base } = useMission();
  const { data, mutate } = useSWR<Roadmap>(`/missions/${mission.id}/roadmap`);
  const [tab, setTab] = useState<"90" | "12">("90");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const open = data?.items.find((i) => i.id === openId);

  async function move(itemId: string, phase: string) {
    const item = data?.items.find((i) => i.id === itemId);
    if (!item || item.phase === phase) return;
    setError(null);
    try {
      await api.post(`/missions/${mission.id}/review/roadmap_item/${itemId}`, { changes: { phase }, comment: "Déplacé dans la roadmap" });
      await mutate();
    } catch (err) {
      setError(err);
    }
  }

  const later = (data?.items ?? []).filter((i) => !NINETY.includes(i.phase));
  return (
    <>
      <PageHeader
        eyebrow="Plan d'action"
        title="Roadmap"
        subtitle="Commencer par les quick wins, préparer les données puis industrialiser. Les dépendances et la capacité de pilotes en parallèle sont respectées."
        actions={
          <div className="inline-flex rounded-lg border border-line bg-white p-0.5 text-sm" role="tablist">
            {(["90", "12"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)} className={clsx("rounded-md px-3 py-1.5 font-semibold", tab === t ? "bg-info text-white" : "text-muted")}>
                {t === "90" ? "90 jours" : "Portefeuille 12 mois"}
              </button>
            ))}
          </div>
        }
      />
      {error ? <ErrorBox error={error} /> : null}
      {!data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty title="Roadmap vide">Lancez l&apos;analyse pour générer le plan d&apos;action.</Empty>
      ) : tab === "90" ? (
        <>
          <div className="grid gap-3 lg:grid-cols-3" data-testid="roadmap-90">
            {data.phases
              .filter((p) => NINETY.includes(p.key))
              .map((p) => {
                const items = data.items.filter((i) => i.phase === p.key);
                return (
                  <div
                    key={p.key}
                    onDragOver={(e) => canWrite && e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      move(e.dataTransfer.getData("text/plain"), p.key);
                    }}
                    className="card border-t-4 border-t-blue-300 p-3"
                    data-phase={p.key}
                  >
                    <div className="eyebrow">{p.label}</div>
                    <div className="mb-1 flex items-baseline justify-between">
                      <h3 className="text-lg font-bold">{p.title}</h3>
                      {data.value_by_phase[p.key] ? <span className="text-xs font-semibold text-value">+{mad(data.value_by_phase[p.key])}/an activés</span> : null}
                    </div>
                    <div className="space-y-2">
                      {items.map((i) => (
                        <ItemCard key={i.id} item={i} draggable={canWrite} onOpen={() => setOpenId(i.id)} />
                      ))}
                      {!items.length && <div className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-muted">Déposez un chantier ici</div>}
                    </div>
                  </div>
                );
              })}
          </div>
          {later.length > 0 && (
            <Card className="mt-4" title={`Au-delà de 90 jours (${later.length})`} action={<button type="button" className="text-xs text-info hover:underline" onClick={() => setTab("12")}>Voir le portefeuille 12 mois →</button>}>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {later.map((i) => (
                  <ItemCard key={i.id} item={i} draggable={canWrite} onOpen={() => setOpenId(i.id)} />
                ))}
              </div>
            </Card>
          )}
        </>
      ) : (
        <Gantt data={data} onOpen={(i) => setOpenId(i.id)} />
      )}
      {canWrite && data && (
        <div className="mt-4">
          <NewItem onCreated={() => mutate()} />
        </div>
      )}
      <Drawer open={!!open} onClose={() => setOpenId(null)} title={open?.title ?? ""} width="max-w-xl">
        {open && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-1.5">
              <Pill tone={ROADMAP_KINDS[open.kind].tone}>{ROADMAP_KINDS[open.kind].label}</Pill>
              <StatusBadge value={open.validation_status} />
              <Pill>
                S{open.start_week + 1} → S{open.start_week + open.duration_weeks}
              </Pill>
            </div>
            <p className="text-gray-700">{open.description}</p>
            {open.depends_on.length > 0 && <div className="text-xs text-check">Dépend de : {open.depends_on.join(", ")}</div>}
            {open.opportunity_id && (
              <Link href={`${base}/opportunities/${open.opportunity_id}`} className="text-info hover:underline">
                → Business case
              </Link>
            )}
            {canWrite && <ItemEditor key={`${open.id}-${open.start_week}-${open.duration_weeks}`} item={open} onSaved={() => mutate()} />}
            <ReviewPanel targetType="roadmap_item" targetId={open.id} status={open.validation_status} onChanged={() => mutate()} />
          </div>
        )}
      </Drawer>
    </>
  );
}
