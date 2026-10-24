"use client";

import { FolderUp, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { mutate } from "swr";
import { JobProgress } from "@/components/sources/JobProgress";
import { ErrorBox } from "@/components/ui";
import { api } from "@/lib/api";
import type { UploadResult } from "@/lib/types";

type Picked = { file: File; path: string };

// Drag & drop of folders: walk FileSystemEntry trees to keep relative paths.
async function walkEntry(entry: FileSystemEntry, prefix = ""): Promise<Picked[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ file, path: prefix + file.name }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    entries.push(...batch);
  }
  const nested = await Promise.all(entries.map((e) => walkEntry(e, `${prefix}${entry.name}/`)));
  return nested.flat();
}

export function UploadPanel({ missionId }: { missionId: string }) {
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  async function send(picked: Picked[]) {
    const files = picked.filter((p) => !p.file.name.startsWith("."));
    if (!files.length) return;
    setSending(true);
    setError(null);
    try {
      const form = new FormData();
      for (const p of files) {
        form.append("files", p.file, p.file.name);
        form.append("paths", p.path);
      }
      setResult(await api.post<UploadResult>(`/missions/${missionId}/documents`, form));
    } catch (err) {
      setError(err);
    } finally {
      setSending(false);
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const items = Array.from(e.dataTransfer.items);
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (entries.length) {
      send((await Promise.all(entries.map((en) => walkEntry(en)))).flat());
    } else {
      send(Array.from(e.dataTransfer.files).map((f) => ({ file: f, path: f.name })));
    }
  }

  const refresh = () => {
    mutate((key) => typeof key === "string" && key.startsWith(`/missions/${missionId}`));
    mutate("/portfolio");
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-2xl border-2 border-dashed px-6 py-8 text-center transition ${dragging ? "border-info bg-info-soft" : "border-line bg-white"}`}
      >
        <Upload className="mx-auto mb-2 text-muted" size={28} />
        <div className="font-semibold">Déposez fichiers ou dossiers ici</div>
        <div className="mt-1 text-xs text-muted">PDF, DOCX, XLSX, CSV, TXT, Markdown, emails (.eml) — doublons détectés par empreinte SHA-256</div>
        <div className="mt-4 flex justify-center gap-2">
          <button type="button" onClick={() => fileInput.current?.click()} className="rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold hover:bg-gray-50" disabled={sending}>
            Choisir des fichiers
          </button>
          <button type="button" onClick={() => folderInput.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold hover:bg-gray-50" disabled={sending}>
            <FolderUp size={15} /> Importer un dossier
          </button>
        </div>
        <input ref={fileInput} type="file" multiple hidden data-testid="file-input" onChange={(e) => send(Array.from(e.target.files ?? []).map((f) => ({ file: f, path: f.name })))} />
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => send(Array.from(e.target.files ?? []).map((f) => ({ file: f, path: f.webkitRelativePath || f.name })))}
        />
      </div>
      {sending && <div className="text-sm text-muted">Envoi en cours…</div>}
      {error ? <ErrorBox error={error} /> : null}
      {result && (
        <div className="space-y-2">
          <div className="text-sm">
            <b>{result.received}</b> fichier(s) reçu(s) · {result.queued} à indexer · {result.duplicates} doublon(s) · {result.errors} erreur(s)
          </div>
          {result.queued > 0 && <JobProgress key={result.job_id} missionId={missionId} jobId={result.job_id} onDone={refresh} />}
        </div>
      )}
    </div>
  );
}
