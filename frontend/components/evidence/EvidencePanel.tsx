"use client";

import { FileSearch } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { DocumentViewer, type Highlight } from "@/components/sources/DocumentViewer";
import { Drawer, Loading, Pill } from "@/components/ui";
import { EVIDENCE_KIND_LABELS } from "@/lib/labels";
import type { Evidence } from "@/lib/types";

export function evidenceHighlight(ev: Evidence): Highlight {
  if (ev.locator.lines) return { lines: ev.locator.lines };
  return { tableId: ev.locator.table_id, rows: ev.locator.rows, columns: ev.locator.columns };
}

export function locatorText(ev: Evidence): string {
  if (ev.locator.lines) {
    const [a, b] = ev.locator.lines;
    return a === b ? `ligne ${a}` : `lignes ${a}–${b}`;
  }
  const count = ev.locator.row_count ?? ev.locator.rows?.length ?? 0;
  const cols = ev.locator.columns?.slice(0, 3).join(", ");
  if (ev.kind === "aggregate") return `${count} ligne(s) · ${cols ?? ""}`;
  if (count) return `${count} ligne(s) citée(s) · ${cols ?? ""}`;
  return "document";
}

export function EvidenceCard({ ev, onOpen }: { ev: Evidence; onOpen: (ev: Evidence) => void }) {
  const [label, tone] = EVIDENCE_KIND_LABELS[ev.kind] ?? ["Preuve", "neutral"];
  return (
    <button type="button" onClick={() => onOpen(ev)} className="block w-full rounded-lg border-l-[3px] border-info bg-gray-50 px-3 py-2 text-left hover:bg-info-soft" data-testid="evidence-card">
      <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
        <b className="truncate">{ev.filename ?? "Source"}</b>
        <span className="flex items-center gap-1">
          <Pill tone={tone}>{label}</Pill>
          {ev.origin === "user" && <Pill tone="check">ajoutée</Pill>}
          <span className="text-muted">{locatorText(ev)}</span>
        </span>
      </div>
      <div className="mt-1 text-xs text-gray-800">{ev.summary}</div>
      {ev.excerpt && ev.kind !== "aggregate" && <div className="mt-1 line-clamp-3 whitespace-pre-wrap font-mono text-[11px] text-muted">{ev.excerpt}</div>}
      {ev.kind === "aggregate" && ev.excerpt && <div className="mt-1 font-mono text-[11px] text-value">{ev.excerpt}</div>}
    </button>
  );
}

export function EvidenceList({ missionId, items }: { missionId: string; items: Evidence[] }) {
  const [open, setOpen] = useState<Evidence | null>(null);
  return (
    <>
      <div className="space-y-2">
        {items.map((ev) => (
          <EvidenceCard key={ev.id} ev={ev} onOpen={setOpen} />
        ))}
      </div>
      <Drawer open={!!open} onClose={() => setOpen(null)} title={open?.summary ?? "Preuve"} width="max-w-3xl">
        {open?.document_id && <DocumentViewer missionId={missionId} documentId={open.document_id} highlight={evidenceHighlight(open)} />}
      </Drawer>
    </>
  );
}

export function EvidencePanel({ missionId, targetType, targetId, emptyLabel }: { missionId: string; targetType: string; targetId: string; emptyLabel?: string }) {
  const { data } = useSWR<Evidence[]>(`/missions/${missionId}/evidence?target_type=${targetType}&target_id=${targetId}`);
  if (!data) return <Loading label="Chargement des preuves…" />;
  if (!data.length)
    return (
      <div className="flex items-center gap-2 rounded-lg bg-check-soft px-3 py-2 text-xs text-check">
        <FileSearch size={14} /> {emptyLabel ?? "Aucune preuve rattachée : hypothèse à valider."}
      </div>
    );
  return <EvidenceList missionId={missionId} items={data} />;
}
