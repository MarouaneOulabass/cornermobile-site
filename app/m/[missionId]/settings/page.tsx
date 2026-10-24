"use client";

import { RotateCcw, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { AnalyzeButton } from "@/components/AnalyzeButton";
import { useMission } from "@/components/shell/MissionContext";
import { Button, Card, ErrorBox, Loading, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { ROLE_LABELS } from "@/lib/hooks/useMe";
import { SCORE_LABELS } from "@/lib/labels";
import type { Benchmark, Member, ScoringModel } from "@/lib/types";

function BenchmarksCard() {
  const { mission } = useMission();
  const key = `/missions/${mission.id}/benchmarks`;
  const { data, mutate } = useSWR<Benchmark[]>(key);
  if (!data) {
    return (
      <Card title="Hypothèses de référence de la mission">
        <Loading />
      </Card>
    );
  }
  return <BenchmarksForm data={data} save={(overrides) => mutate(api.put<Benchmark[]>(key, { overrides }), { revalidate: false })} />;
}

function BenchmarksForm({
  data,
  save: persist,
}: {
  data: Benchmark[];
  save: (overrides: Record<string, number | null>) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.map((b) => [b.key, b.overridden ? String(b.value) : ""])),
  );
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save() {
    setError(null);
    const overrides: Record<string, number | null> = {};
    for (const b of data) {
      const raw = (draft[b.key] ?? "").trim().replace(",", ".");
      const next = raw === "" ? null : Number(raw);
      if (next !== null && Number.isNaN(next)) return setError(new Error(`Valeur invalide : ${b.label}`));
      if (next !== (b.overridden ? b.value : null)) overrides[b.key] = next;
    }
    try {
      await persist(overrides);
      setSaved(true);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Card title="Hypothèses de référence de la mission" action={<Pill tone="check">Hypothèses</Pill>}>
      <p className="mb-3 text-sm text-muted">
        Utilisées uniquement quand les sources ne donnent pas la valeur. Elles apparaissent comme « hypothèse » dans chaque business case.
        Laissez vide pour garder la valeur par défaut.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th className="py-1.5">Référence</th>
            <th className="py-1.5 text-right">Défaut</th>
            <th className="w-36 py-1.5 pl-3">Valeur de la mission</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.map((b) => (
            <tr key={b.key}>
              <td className="py-2 pr-3">
                <div className="font-semibold">{b.label}</div>
                <div className="text-xs text-muted">{b.rationale}</div>
              </td>
              <td className="whitespace-nowrap py-2 text-right text-muted">
                {b.default} {b.unit}
              </td>
              <td className="py-2 pl-3">
                <input
                  className="input w-full"
                  inputMode="decimal"
                  placeholder={String(b.default)}
                  value={draft[b.key] ?? ""}
                  aria-label={b.label}
                  onChange={(e) => {
                    setSaved(false);
                    setDraft({ ...draft, [b.key]: e.target.value });
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap items-start gap-3">
        <Button variant="primary" onClick={save}>
          <Save size={14} /> Enregistrer
        </Button>
        {saved && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-value">
            Enregistré. Les nouvelles valeurs s&apos;appliquent à la prochaine analyse.
            <AnalyzeButton label="Relancer l'analyse" variant="default" />
          </div>
        )}
      </div>
      {error ? (
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
    </Card>
  );
}

function ScoringCard() {
  const { mission } = useMission();
  const { data } = useSWR<ScoringModel>(`/missions/${mission.id}/scoring-model`);
  const [revision, setRevision] = useState(0);
  if (!data) {
    return (
      <Card title="Modèle de priorisation">
        <Loading />
      </Card>
    );
  }
  return <ScoringForm key={revision} initial={data} reset={() => setRevision((r) => r + 1)} />;
}

function ScoringForm({ initial, reset }: { initial: ScoringModel; reset: () => void }) {
  const { mission, role } = useMission();
  const key = `/missions/${mission.id}/scoring-model`;
  const [model, setModel] = useState<ScoringModel>(initial);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const isAdmin = role === "admin";

  const set = (group: keyof ScoringModel, k: string, v: number) => {
    setSaved(false);
    setModel({ ...model, [group]: { ...model[group], [k]: v } });
  };
  const total = Object.values(model.weights).reduce((a, b) => a + b, 0);

  async function save(next: ScoringModel) {
    setError(null);
    try {
      await globalMutate(
        key,
        api.put<ScoringModel>(key, {
          weights: next.weights,
          penalties: next.penalties,
        }),
        { revalidate: false },
      );
      await globalMutate((k) => typeof k === "string" && k.startsWith(`/missions/${mission.id}/`));
      setSaved(true);
    } catch (err) {
      setError(err);
    }
  }

  const row = (group: keyof ScoringModel, k: string, v: number) => (
    <div key={`${group}:${k}`} className="grid grid-cols-[1fr_120px_40px] items-center gap-3 py-1 text-sm">
      <span>{SCORE_LABELS[k] ?? k}</span>
      <input
        type="range"
        min={0}
        max={0.5}
        step={0.05}
        value={v}
        disabled={!isAdmin}
        aria-label={SCORE_LABELS[k] ?? k}
        onChange={(e) => set(group, k, Number(e.target.value))}
      />
      <span className="text-right tabular-nums">{v.toFixed(2)}</span>
    </div>
  );

  return (
    <Card title="Modèle de priorisation" action={!isAdmin && <Pill>Lecture seule (administrateur)</Pill>}>
      <p className="mb-3 text-sm text-muted">
        Priorité = Σ coefficient × sous-score − Σ pénalité × sous-score ; les étiquettes P1/P2/P3 sont attribuées par rang. Une modification
        recalcule immédiatement les scores de l&apos;organisation.
      </p>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Critères (somme {total.toFixed(2)})</div>
          {Object.entries(model.weights).map(([k, v]) => row("weights", k, v))}
        </div>
        <div>
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Pénalités</div>
          {Object.entries(model.penalties).map(([k, v]) => row("penalties", k, v))}
        </div>
      </div>
      {isAdmin && (
        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" onClick={() => save(model)}>
            <Save size={14} /> Appliquer
          </Button>
          <Button variant="ghost" onClick={reset}>
            <RotateCcw size={14} /> Annuler
          </Button>
          {saved && <span className="text-sm text-value">Scores recalculés.</span>}
        </div>
      )}
      {error ? (
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
    </Card>
  );
}

function DataCard() {
  const { mission, organization, role } = useMission();
  const router = useRouter();
  const [days, setDays] = useState(String(organization.retention_days));
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const isAdmin = role === "admin";

  async function saveRetention() {
    setError(null);
    try {
      await api.patch(`/orgs/${organization.id}`, {
        retention_days: Number(days),
      });
      await globalMutate(`/orgs/${organization.id}`);
      setSaved(true);
    } catch (err) {
      setError(err);
    }
  }

  async function remove() {
    setError(null);
    try {
      await api.del(`/missions/${mission.id}`);
      await globalMutate("/portfolio");
      router.replace("/");
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Card title="Données et conformité">
      <ul className="mb-4 space-y-1 text-sm text-muted">
        <li>• Données isolées par organisation ; les actions sensibles sont tracées dans le journal d&apos;audit, sans contenu.</li>
        <li>• Les données personnelles sont masquées avant tout appel à un modèle de langage ; aucun chiffre n&apos;en provient.</li>
        <li>• Aucune donnée client n&apos;est utilisée pour entraîner un modèle.</li>
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1 block font-semibold">Rétention (jours sans activité)</span>
          <input
            className="input w-40"
            type="number"
            min={1}
            max={3650}
            value={days}
            disabled={!isAdmin}
            onChange={(e) => {
              setSaved(false);
              setDays(e.target.value);
            }}
          />
        </label>
        {isAdmin && (
          <Button onClick={saveRetention} disabled={Number(days) === organization.retention_days}>
            <Save size={14} /> Enregistrer
          </Button>
        )}
        {saved && <span className="text-sm text-value">Enregistré.</span>}
      </div>
      <p className="mt-1 text-xs text-muted">Au-delà, la mission et tous ses fichiers sont supprimés automatiquement.</p>
      {isAdmin && (
        <div className="mt-5 rounded-xl border border-risk/30 bg-risk-soft/40 p-3">
          <div className="text-sm font-semibold text-risk">Supprimer définitivement la mission</div>
          <p className="mt-1 text-xs text-muted">
            Sources, analyses, validations, rapports et fichiers stockés. Tapez « {organization.name} » pour confirmer.
          </p>
          <div className="mt-2 flex gap-2">
            <input className="input flex-1" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirmation" />
            <Button variant="danger" disabled={confirm !== organization.name} onClick={remove}>
              <Trash2 size={14} /> Supprimer
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      ) : null}
    </Card>
  );
}

function MembersCard() {
  const { organization } = useMission();
  const { data } = useSWR<Member[]>(`/orgs/${organization.id}/members`);
  return (
    <Card title="Accès">
      {!data ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-line text-sm">
          {data.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="font-semibold">{m.full_name}</div>
                <div className="truncate text-xs text-muted">{m.email}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {m.department_scope && <Pill>{m.department_scope}</Pill>}
                <Pill tone={m.role === "executive" || m.role === "business_owner" ? "info" : "neutral"}>{ROLE_LABELS[m.role]}</Pill>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        Un responsable métier ne voit que les constats de son département ; les clients ne voient jamais les éléments rejetés.
      </p>
    </Card>
  );
}

export default function SettingsPage() {
  const { canWrite } = useMission();
  if (!canWrite) return null;
  return (
    <div>
      <PageHeader eyebrow="Administration" title="Paramètres" subtitle="Hypothèses de la mission, priorisation, données et accès." />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-4">
          <BenchmarksCard />
          <ScoringCard />
        </div>
        <div className="space-y-4">
          <DataCard />
          <MembersCard />
        </div>
      </div>
    </div>
  );
}
