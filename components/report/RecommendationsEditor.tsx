"use client";

import clsx from "clsx";
import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/findings/Badges";
import { useMission } from "@/components/shell/MissionContext";
import { Button, ErrorBox, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import type { Recommendation, ValidationStatus } from "@/lib/types";

function RecommendationRow({ rec, onChanged }: { rec: Recommendation; onChanged: () => void }) {
  const { mission, canWrite } = useMission();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(rec.title);
  const [text, setText] = useState(rec.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const url = `/missions/${mission.id}/review/recommendation/${rec.id}`;

  async function send(body: { status?: ValidationStatus; changes?: Record<string, string> }) {
    setBusy(true);
    setError(null);
    try {
      await api.post(url, body);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function save() {
    const changes: Record<string, string> = {};
    if (title.trim() !== rec.title) changes.title = title.trim();
    if (text.trim() !== rec.text) changes.text = text.trim();
    if (Object.keys(changes).length === 0) return setEditing(false);
    void send({ changes });
  }

  const rejected = rec.validation_status === "rejete";
  return (
    <li className={clsx("rounded-xl border border-line p-3", rejected && "opacity-60")} data-testid="recommendation">
      {editing ? (
        <div className="space-y-2">
          <input className="input w-full font-semibold" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Titre" />
          <textarea className="input min-h-28 w-full text-sm" value={text} onChange={(e) => setText(e.target.value)} aria-label="Texte" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setTitle(rec.title), setText(rec.text))}>
              Annuler
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !title.trim() || !text.trim()} onClick={save}>
              Enregistrer
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <div className={clsx("text-sm font-semibold", rejected && "line-through")}>{rec.title}</div>
            <div className="flex shrink-0 items-center gap-1">
              {rec.edited_fields.length > 0 && <Pill tone="info">Rédigé par le consultant</Pill>}
              {rec.generated.stale && <Pill tone="check" title="L'analyse ne produit plus cette recommandation">Obsolète</Pill>}
              <StatusBadge value={rec.validation_status} />
            </div>
          </div>
          <p className={clsx("mt-1 text-sm text-gray-700", rejected && "line-through")}>{rec.text}</p>
          {canWrite && (
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" onClick={() => setEditing(true)}>
                <Pencil size={12} /> Modifier
              </Button>
              {rec.validation_status !== "valide" && rec.validation_status !== "corrige" && (
                <Button size="sm" disabled={busy} onClick={() => send({ status: "valide" })}>
                  <Check size={12} /> Valider
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy} title="Retirer cette recommandation du rapport" onClick={() => send({ status: rejected ? "a_verifier" : "rejete" })}>
                <X size={12} /> {rejected ? "Rétablir" : "Exclure"}
              </Button>
            </div>
          )}
        </>
      )}
      {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}
    </li>
  );
}

/** The executive narrative of the report: generated from scored items, rewritten and validated by the consultant. */
export function RecommendationsEditor({ items, onChanged }: { items: Recommendation[]; onChanged: () => void }) {
  return (
    <ul className="space-y-2">
      {items.map((rec) => (
        <RecommendationRow key={`${rec.id}:${rec.title}:${rec.text}`} rec={rec} onChanged={onChanged} />
      ))}
    </ul>
  );
}
