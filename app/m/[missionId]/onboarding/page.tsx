"use client";

import { Check, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { mutate } from "swr";
import { useMission } from "@/components/shell/MissionContext";
import { UploadPanel } from "@/components/sources/UploadPanel";
import { AnalyzeButton } from "@/components/AnalyzeButton";
import { Button, Card, ErrorBox, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import type { InterviewItem, Mission, Organization } from "@/lib/types";

function useSaver() {
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err);
    }
  }
  return { error, saved, run };
}

function CompanyCard({ org }: { org: Organization }) {
  const [form, setForm] = useState({
    name: org.name,
    sector: org.sector ?? "",
    city: org.city ?? "",
    employees: org.employees?.toString() ?? "",
    revenue_mad: org.revenue_mad?.toString() ?? "",
    description: org.description ?? "",
  });
  const { error, saved, run } = useSaver();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const save = () =>
    run(async () => {
      await api.patch(`/orgs/${org.id}`, {
        ...form,
        employees: form.employees ? Number(form.employees) : null,
        revenue_mad: form.revenue_mad ? Number(form.revenue_mad) : null,
      });
      await mutate(`/orgs/${org.id}`);
    });
  return (
    <Card title="1. Informations entreprise" action={<Button size="sm" onClick={save}>{saved ? <><Check size={14} /> Enregistré</> : "Enregistrer"}</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="label">Raison sociale</span>
          <input className="input" value={form.name} onChange={set("name")} />
        </label>
        <label>
          <span className="label">Secteur</span>
          <input className="input" value={form.sector} onChange={set("sector")} />
        </label>
        <label>
          <span className="label">Ville</span>
          <input className="input" value={form.city} onChange={set("city")} />
        </label>
        <label>
          <span className="label">Effectif</span>
          <input className="input" type="number" min={0} value={form.employees} onChange={set("employees")} />
        </label>
        <label>
          <span className="label">CA annuel (MAD)</span>
          <input className="input" type="number" min={0} value={form.revenue_mad} onChange={set("revenue_mad")} />
        </label>
        <label className="sm:col-span-2">
          <span className="label">Présentation</span>
          <textarea className="input min-h-16" value={form.description} onChange={set("description")} />
        </label>
      </div>
      {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}
    </Card>
  );
}

function ObjectivesCard({ mission }: { mission: Mission }) {
  const [objectives, setObjectives] = useState(mission.objectives.join("\n"));
  const [scope, setScope] = useState(mission.scope.join("\n"));
  const { error, saved, run } = useSaver();
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const save = () =>
    run(async () => {
      await api.patch(`/missions/${mission.id}`, { objectives: lines(objectives), scope: lines(scope) });
      await mutate(`/missions/${mission.id}`);
    });
  return (
    <Card title="2. Objectifs et périmètre" action={<Button size="sm" onClick={save}>{saved ? <><Check size={14} /> Enregistré</> : "Enregistrer"}</Button>}>
      <div className="grid gap-3 md:grid-cols-2">
        <label>
          <span className="label">Objectifs (un par ligne)</span>
          <textarea className="input min-h-32" value={objectives} onChange={(e) => setObjectives(e.target.value)} />
        </label>
        <label>
          <span className="label">Périmètre (un domaine par ligne)</span>
          <textarea className="input min-h-32" value={scope} onChange={(e) => setScope(e.target.value)} />
        </label>
      </div>
      {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}
    </Card>
  );
}

function InterviewsCard({ mission }: { mission: Mission }) {
  const [items, setItems] = useState<InterviewItem[]>(mission.interview_checklist);
  const [draft, setDraft] = useState("");
  const { error, run } = useSaver();
  const persist = (next: InterviewItem[]) => {
    setItems(next);
    return run(async () => {
      await api.patch(`/missions/${mission.id}`, { interview_checklist: next });
      await mutate(`/missions/${mission.id}`);
    });
  };
  const done = items.filter((i) => i.done).length;
  return (
    <Card title="3. Checklist d'entretiens" action={<Pill tone={done === items.length && items.length ? "value" : "check"}>{done}/{items.length} réalisés</Pill>}>
      <ul className="space-y-2">
        {items.map((item, idx) => (
          <li key={item.id} className="rounded-xl border border-line p-3">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-[var(--color-value)]"
                checked={item.done}
                aria-label={`Entretien réalisé : ${item.question}`}
                onChange={() => persist(items.map((it, i) => (i === idx ? { ...it, done: !it.done } : it)))}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{item.question}</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-[200px_1fr]">
                  <input
                    className="input"
                    placeholder="Interlocuteur"
                    defaultValue={item.interviewee ?? ""}
                    onBlur={(e) => e.target.value !== (item.interviewee ?? "") && persist(items.map((it, i) => (i === idx ? { ...it, interviewee: e.target.value || null } : it)))}
                  />
                  <input
                    className="input"
                    placeholder="Notes d'entretien (verbatim, chiffres cités…)"
                    defaultValue={item.notes ?? ""}
                    onBlur={(e) => e.target.value !== (item.notes ?? "") && persist(items.map((it, i) => (i === idx ? { ...it, notes: e.target.value || null } : it)))}
                  />
                </div>
              </div>
              <button type="button" className="rounded p-1 text-muted hover:bg-gray-100" aria-label="Supprimer" onClick={() => persist(items.filter((_, i) => i !== idx))}>
                <Trash2 size={15} />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          persist([...items, { id: crypto.randomUUID().slice(0, 8), question: draft.trim(), interviewee: null, done: false, notes: null }]);
          setDraft("");
        }}
      >
        <input className="input" placeholder="Ajouter un entretien…" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit" size="sm">
          <Plus size={14} /> Ajouter
        </Button>
      </form>
      {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}
    </Card>
  );
}

export default function OnboardingPage() {
  const { mission, organization } = useMission();
  return (
    <>
      <PageHeader eyebrow="Onboarding mission" title={mission.name} subtitle="Cadrez la mission, importez les sources puis lancez l'analyse." />
      <div className="space-y-4">
        <CompanyCard org={organization} />
        <ObjectivesCard mission={mission} />
        <InterviewsCard mission={mission} />
        <Card title="4. Import des sources">
          <UploadPanel missionId={mission.id} />
        </Card>
        <Card title="5. Lancement de l'analyse">
          <p className="mb-3 text-sm text-muted">
            L&apos;analyse reconstruit l&apos;organisation, les processus et le business graph, détecte les irritants à partir des preuves, chiffre les opportunités et propose une roadmap. Tout reste modifiable et traçable.
          </p>
          <AnalyzeButton label={mission.analysis_version ? "Relancer l'analyse" : "Lancer l'analyse"} />
        </Card>
      </div>
    </>
  );
}
