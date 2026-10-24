"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { mutate } from "swr";
import { RequireAuth } from "@/components/shell/RequireAuth";
import { Button, Card, ErrorBox, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { Mission, Organization } from "@/lib/types";

const DEFAULT_OBJECTIVES = [
  "Améliorer la marge opérationnelle sans augmenter fortement les effectifs.",
  "Réduire les délais et la dépendance aux fichiers Excel.",
  "Identifier des cas d'usage IA avec ROI mesurable en moins de 12 mois.",
];

function NewMissionForm() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", sector: "", city: "", employees: "", revenue_mad: "", description: "" });
  const [objectives, setObjectives] = useState(DEFAULT_OBJECTIVES.join("\n"));
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const org = await api.post<Organization>("/orgs", {
        name: form.name,
        sector: form.sector || null,
        city: form.city || null,
        employees: form.employees ? Number(form.employees) : null,
        revenue_mad: form.revenue_mad ? Number(form.revenue_mad) : null,
        description: form.description || null,
      });
      const mission = await api.post<Mission>(`/orgs/${org.id}/missions`, {
        name: "Audit IA & Performance",
        objectives: objectives.split("\n").map((s) => s.trim()).filter(Boolean),
        scope: ["Processus cœur", "Finance", "Relation client", "Outils & données"],
      });
      await mutate("/portfolio");
      await mutate("/auth/me");
      router.push(`/m/${mission.id}/onboarding`);
    } catch (err) {
      setError(err);
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/" className="text-sm text-info hover:underline">
        ← Portefeuille
      </Link>
      <PageHeader eyebrow="Onboarding" title="Nouvelle mission d'audit" subtitle="Informations entreprise et objectifs. L'import des sources et la checklist d'entretiens viennent ensuite." />
      <form onSubmit={submit}>
        <Card title="Entreprise">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="label">Raison sociale *</span>
              <input className="input" value={form.name} onChange={set("name")} required minLength={2} />
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
              <textarea className="input min-h-20" value={form.description} onChange={set("description")} />
            </label>
            <label className="sm:col-span-2">
              <span className="label">Objectifs de la direction (un par ligne)</span>
              <textarea className="input min-h-24" value={objectives} onChange={(e) => setObjectives(e.target.value)} />
            </label>
          </div>
        </Card>
        {error ? (
          <div className="mt-3">
            <ErrorBox error={error} />
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button variant="primary" type="submit" disabled={pending}>
            {pending ? "Création…" : "Créer la mission"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function NewMissionPage() {
  return (
    <RequireAuth>
      <NewMissionForm />
    </RequireAuth>
  );
}
