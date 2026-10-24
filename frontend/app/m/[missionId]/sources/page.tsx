"use client";

import { FileSpreadsheet, FileText, Mail, Search, X } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { useMission } from "@/components/shell/MissionContext";
import { DocumentViewer, type Highlight } from "@/components/sources/DocumentViewer";
import { UploadPanel } from "@/components/sources/UploadPanel";
import { Button, Card, Drawer, Empty, Loading, PageHeader, Pill, Stat } from "@/components/ui";
import { num } from "@/lib/format";
import { CATEGORY_LABELS, DOC_STATUS_LABELS } from "@/lib/labels";
import type { DocumentItem, LibraryStats, SearchHit } from "@/lib/types";

function DocIcon({ type }: { type: string }) {
  if (type === "csv" || type === "xlsx") return <FileSpreadsheet size={16} className="text-value" />;
  if (type === "eml") return <Mail size={16} className="text-info" />;
  return <FileText size={16} className="text-muted" />;
}

function kb(bytes: number) {
  return bytes < 1024 ? `${bytes} o` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} Ko` : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

export default function SourcesPage() {
  const { mission, canWrite } = useMission();
  const base = `/missions/${mission.id}`;
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [open, setOpen] = useState<{ id: string; highlight?: Highlight } | null>(null);

  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (status) params.set("status", status);
  const { data: docs } = useSWR<DocumentItem[]>(`${base}/documents?${params}`);
  const { data: stats } = useSWR<LibraryStats>(`${base}/documents/stats`);
  const { data: hits, isLoading: searching } = useSWR<SearchHit[]>(submitted ? `${base}/search?q=${encodeURIComponent(submitted)}&limit=12` : null);

  const tabular = (stats?.by_type.csv ?? 0) + (stats?.by_type.xlsx ?? 0);

  return (
    <>
      <PageHeader
        eyebrow="Bibliothèque"
        title="Sources analysées"
        subtitle="Tous les éléments utilisés par l'audit restent consultables et citables. Les originaux sont conservés intacts."
        actions={canWrite && <Button variant="primary" onClick={() => setShowUpload((v) => !v)}>{showUpload ? "Fermer" : "+ Importer"}</Button>}
      />
      {showUpload && (
        <div className="mb-5">
          <UploadPanel missionId={mission.id} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <Stat label="Fichiers indexés" value={stats?.by_status.indexed ?? "—"} hint={`${stats?.total ?? 0} fichiers au total`} />
        <Stat label="Tableaux de données" value={tabular} hint={`${num(stats?.rows)} lignes exploitables`} />
        <Stat label="Documents" value={(stats?.total ?? 0) - tabular} hint="procédures, rapports, emails…" />
        <Stat label="Contrats" value={stats?.by_category.contrats ?? 0} hint={stats?.by_status.error ? `${stats.by_status.error} en erreur` : "aucune erreur d'import"} tone={stats?.by_status.error ? "risk" : undefined} />
      </div>

      <Card className="mt-5">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-2.5 text-muted" />
            <input className="input pl-9" placeholder="Rechercher dans les sources (ex. « pénalité SLA », « ressaisie devis »)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Recherche plein texte" />
          </div>
          <Button type="submit">Rechercher</Button>
          {submitted && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSubmitted("");
                setQuery("");
              }}
              aria-label="Effacer la recherche"
            >
              <X size={15} />
            </Button>
          )}
        </form>
        {submitted && (
          <div className="mt-3 space-y-2">
            {searching && <Loading label="Recherche…" />}
            {hits?.length === 0 && <div className="text-sm text-muted">Aucun passage trouvé.</div>}
            {hits?.map((h) => (
              <button
                type="button"
                key={`${h.document_id}-${h.start_line}`}
                className="block w-full rounded-xl border-l-[3px] border-info bg-gray-50 px-3 py-2 text-left hover:bg-info-soft"
                onClick={() => setOpen({ id: h.document_id, highlight: { lines: [h.start_line, h.end_line] } })}
              >
                <div className="flex items-center justify-between text-xs">
                  <b>{h.filename}</b>
                  <span className="text-muted">
                    lignes {h.start_line}–{h.end_line} · {CATEGORY_LABELS[h.category ?? "autre"]}
                  </span>
                </div>
                <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-gray-700">{h.excerpt}</div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filtrer par catégorie">
          <option value="">Toutes catégories</option>
          {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v} {stats?.by_category[k] ? `(${stats.by_category[k]})` : ""}
            </option>
          ))}
        </select>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filtrer par statut">
          <option value="">Tous statuts</option>
          {Object.entries(DOC_STATUS_LABELS).map(([k, [v]]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="text-sm text-muted">{docs?.length ?? 0} élément(s)</span>
      </div>

      <div className="mt-3">
        {!docs ? (
          <Loading />
        ) : docs.length === 0 ? (
          <Empty title="Aucune source">{canWrite ? "Importez des fichiers ou un dossier complet pour démarrer." : "Le consultant n'a pas encore importé de sources."}</Empty>
        ) : (
          <div className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3" data-testid="doc-grid">
            {docs.map((d) => {
              const [label, tone] = DOC_STATUS_LABELS[d.status];
              return (
                <button type="button" key={d.id} onClick={() => setOpen({ id: d.id })} className="rounded-xl border border-line bg-white p-3 text-left transition hover:border-info">
                  <div className="flex items-start gap-2">
                    <DocIcon type={d.file_type} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{d.filename}</div>
                      <div className="truncate text-xs text-muted">{d.title !== d.filename ? d.title : d.path}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    <Pill tone="info">{CATEGORY_LABELS[d.category ?? "autre"] ?? "—"}</Pill>
                    <Pill tone={tone}>{label}</Pill>
                    {d.version > 1 && <Pill>v{d.version}</Pill>}
                    <span className="ml-auto text-[11px] text-muted">{kb(d.size_bytes)}</span>
                  </div>
                  {d.error && <div className="mt-1 truncate text-[11px] text-risk">{d.error}</div>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Drawer open={!!open} onClose={() => setOpen(null)} title="Source" width="max-w-3xl">
        {open && <DocumentViewer missionId={mission.id} documentId={open.id} highlight={open.highlight} canWrite={canWrite} />}
      </Drawer>
    </>
  );
}
