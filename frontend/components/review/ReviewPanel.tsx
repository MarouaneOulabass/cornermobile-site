"use client";

import { Check, MessageSquare, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { useMission } from "@/components/shell/MissionContext";
import { Button, ErrorBox, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { datetime } from "@/lib/format";
import { VALIDATION_LABELS } from "@/lib/labels";
import type { Comment, Validation, ValidationStatus } from "@/lib/types";

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Validation status, decision buttons, history (who/when/what changed) and comments. */
export function ReviewPanel({
  targetType,
  targetId,
  status,
  onChanged,
}: {
  targetType: string;
  targetId: string;
  status: ValidationStatus;
  onChanged?: () => void;
}) {
  const { mission, canWrite, role } = useMission();
  const base = `/missions/${mission.id}`;
  const historyKey = `${base}/review/${targetType}/${targetId}`;
  const commentsKey = `${base}/comments?target_type=${targetType}&target_id=${targetId}`;
  const { data: history } = useSWR<Validation[]>(historyKey);
  const { data: comments } = useSWR<Comment[]>(commentsKey);
  const [note, setNote] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<unknown>(null);

  async function decide(next: ValidationStatus) {
    setError(null);
    try {
      await api.post(`${base}/review/${targetType}/${targetId}`, { status: next, comment: note || null });
      setNote("");
      await mutate(historyKey);
      onChanged?.();
    } catch (err) {
      setError(err);
    }
  }

  async function comment(kind: "comment" | "contestation") {
    if (!body.trim()) return;
    setError(null);
    try {
      await api.post(`${base}/comments`, { target_type: targetType, target_id: targetId, body, kind });
      setBody("");
      await mutate(commentsKey);
      onChanged?.();
    } catch (err) {
      setError(err);
    }
  }

  const [label, tone] = VALIDATION_LABELS[status];
  return (
    <div className="space-y-3" data-testid="review-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Statut</span>
        <Pill tone={tone}>{label}</Pill>
        {history?.[0] && (
          <span className="text-xs text-muted">
            par {history[0].user_name} · {datetime(history[0].created_at)}
          </span>
        )}
      </div>
      {canWrite && (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <input className="input" placeholder="Note de revue (optionnelle)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => decide("valide")}>
              <Check size={14} /> Valider
            </Button>
            <Button size="sm" variant="danger" onClick={() => decide("rejete")}>
              <X size={14} /> Rejeter
            </Button>
            <Button size="sm" onClick={() => decide("a_verifier")}>
              <RotateCcw size={14} /> À vérifier
            </Button>
          </div>
        </div>
      )}
      {error ? <ErrorBox error={error} /> : null}
      {history && history.length > 0 && (
        <div>
          <div className="eyebrow mb-1.5">Historique</div>
          <ul className="space-y-1.5 text-xs">
            {history.map((h) => (
              <li key={h.id} className="rounded-lg bg-gray-50 px-2.5 py-1.5">
                <div className="flex justify-between gap-2">
                  <span>
                    <b>{h.user_name}</b> → {VALIDATION_LABELS[h.status][0]}
                  </span>
                  <span className="text-muted">{datetime(h.created_at)}</span>
                </div>
                {h.comment && <div className="text-gray-700">« {h.comment} »</div>}
                {Object.entries(h.changes).map(([field, change]) => (
                  <div key={field} className="text-muted">
                    {field} : <s>{fmt(change.before)}</s> → <b className="text-ink">{fmt(change.after)}</b>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="eyebrow mb-1.5 flex items-center gap-1">
          <MessageSquare size={12} /> Commentaires
        </div>
        <ul className="space-y-1.5 text-xs">
          {comments?.map((c) => (
            <li key={c.id} className={`rounded-lg px-2.5 py-1.5 ${c.kind === "contestation" ? "bg-check-soft" : "bg-gray-50"}`}>
              <div className="flex justify-between">
                <b>
                  {c.user_name}
                  {c.kind === "contestation" && " — conteste"}
                </b>
                <span className="text-muted">{datetime(c.created_at)}</span>
              </div>
              <div>{c.body}</div>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <input className="input" placeholder="Ajouter un commentaire…" value={body} onChange={(e) => setBody(e.target.value)} />
          <Button size="sm" onClick={() => comment("comment")}>
            Envoyer
          </Button>
          {role !== "consultant" && role !== "admin" && (
            <Button size="sm" variant="danger" onClick={() => comment("contestation")} title="Contester ce point : il repasse « à vérifier »">
              Contester
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
