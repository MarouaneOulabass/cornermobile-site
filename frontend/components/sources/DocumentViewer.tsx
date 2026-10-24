"use client";

import clsx from "clsx";
import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import { Button, Loading, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { datetime } from "@/lib/format";
import { CATEGORY_LABELS, DOC_STATUS_LABELS, METHOD_LABELS } from "@/lib/labels";
import type { DocumentDetail, DocumentLines, TableRows } from "@/lib/types";

export interface Highlight {
  lines?: [number, number];
  tableId?: string;
  rows?: number[];
  columns?: string[];
}

function TextView({ missionId, docId, lines }: { missionId: string; docId: string; lines?: [number, number] }) {
  const { data } = useSWR<DocumentLines>(`/missions/${missionId}/documents/${docId}/lines`);
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center" });
  }, [data]);
  if (!data) return <Loading />;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-gray-50 font-mono text-xs leading-5" data-testid="text-view">
      {data.lines.map((line, i) => {
        const n = data.start + i;
        const hit = lines && n >= lines[0] && n <= lines[1];
        return (
          <div key={n} ref={lines && n === lines[0] ? target : undefined} className={clsx("flex", hit && "bg-yellow-100")}>
            <span className="w-10 shrink-0 select-none border-r border-line px-2 text-right text-gray-400">{n}</span>
            <span className="whitespace-pre-wrap px-2">{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function TableView({ missionId, tableId, rows, columns }: { missionId: string; tableId: string; rows?: number[]; columns?: string[] }) {
  const [offset, setOffset] = useState(0);
  const [onlyCited, setOnlyCited] = useState(!!rows?.length);
  const query = onlyCited && rows?.length ? `rows=${rows.slice(0, 500).join(",")}` : `offset=${offset}&limit=50`;
  const { data } = useSWR<TableRows>(`/missions/${missionId}/tables/${tableId}?${query}`);
  if (!data) return <Loading />;
  const cited = new Set(rows ?? []);
  const citedCols = new Set(columns ?? []);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {data.name} — {data.row_count} lignes · {data.columns.length} colonnes
        </span>
        {rows?.length ? (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={onlyCited} onChange={(e) => setOnlyCited(e.target.checked)} />
            Lignes citées uniquement ({rows.length})
          </label>
        ) : null}
      </div>
      <div className="max-h-[60vh] overflow-auto rounded-xl border border-line">
        <table className="min-w-full text-xs" data-testid="table-view">
          <thead className="sticky top-0 bg-gray-50">
            <tr>
              <th className="px-2 py-1.5 text-left text-gray-400">#</th>
              {data.columns.map((c) => (
                <th key={c} className={clsx("whitespace-nowrap px-2 py-1.5 text-left font-semibold", citedCols.has(c) ? "bg-yellow-100 text-ink" : "text-muted")} title={data.column_types[c]}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => {
              const n = data.row_numbers[i];
              return (
                <tr key={n} className={clsx("border-t border-line", cited.has(n) && !onlyCited && "bg-yellow-50")}>
                  <td className="px-2 py-1 text-gray-400">{n}</td>
                  {row.map((cell, j) => (
                    <td key={j} className={clsx("whitespace-nowrap px-2 py-1", citedCols.has(data.columns[j]) && "bg-yellow-50 font-semibold")}>
                      {cell}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!onlyCited && (
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Précédent
          </Button>
          <Button size="sm" disabled={offset + 50 >= data.row_count} onClick={() => setOffset(offset + 50)}>
            Suivant
          </Button>
        </div>
      )}
    </div>
  );
}

export function DocumentViewer({ missionId, documentId, highlight, canWrite = false }: { missionId: string; documentId: string; highlight?: Highlight; canWrite?: boolean }) {
  const { data: doc } = useSWR<DocumentDetail>(`/missions/${missionId}/documents/${documentId}`);
  if (!doc) return <Loading />;
  const [statusLabel, statusTone] = DOC_STATUS_LABELS[doc.status];
  const table = doc.tables.find((t) => t.id === highlight?.tableId) ?? (doc.file_type === "csv" || doc.file_type === "xlsx" ? doc.tables[0] : undefined);
  const metaEntries = Object.entries(doc.meta).filter(([k, v]) => !["classification_scores", "columns"].includes(k) && v !== null && typeof v !== "object");

  async function reclassify(category: string) {
    await api.patch(`/missions/${missionId}/documents/${documentId}`, { category });
    mutate(`/missions/${missionId}/documents/${documentId}`);
    mutate((key) => typeof key === "string" && key.startsWith(`/missions/${missionId}/documents`));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-muted">{doc.path}</div>
          <div className="font-bold">{doc.title}</div>
        </div>
        <a href={`/api/missions/${missionId}/documents/${documentId}/download`} className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold hover:bg-gray-50">
          <Download size={13} /> Original
        </a>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        <Pill tone={statusTone}>{statusLabel}</Pill>
        <Pill tone="info">{CATEGORY_LABELS[doc.category ?? "autre"] ?? doc.category}</Pill>
        <Pill>
          classé par {METHOD_LABELS[doc.classification_method ?? ""] ?? "—"} · {Math.round((doc.category_confidence ?? 0) * 100)} %
        </Pill>
        <Pill>v{doc.version}</Pill>
        <Pill>importé {datetime(doc.created_at)}</Pill>
      </div>
      {canWrite && (
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted">Corriger la catégorie</span>
          <select className="input w-auto py-1" value={doc.category ?? "autre"} onChange={(e) => reclassify(e.target.value)}>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      )}
      {metaEntries.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-gray-50 p-3 text-xs">
          {metaEntries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="truncate">{String(v)}</dd>
            </div>
          ))}
          <dt className="text-muted">sha256</dt>
          <dd className="truncate font-mono">{doc.sha256.slice(0, 16)}…</dd>
        </dl>
      )}
      {doc.error && <div className="rounded-xl bg-risk-soft p-3 text-xs text-risk">{doc.error}</div>}
      {table ? (
        <TableView missionId={missionId} tableId={table.id} rows={highlight?.rows} columns={highlight?.columns} />
      ) : doc.status === "indexed" ? (
        <TextView missionId={missionId} docId={documentId} lines={highlight?.lines} />
      ) : null}
    </div>
  );
}
