"use client";

import { Download, ExternalLink, FileText, Send, Undo2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { RecommendationsEditor } from "@/components/report/RecommendationsEditor";
import { useMission } from "@/components/shell/MissionContext";
import { Button, buttonClasses, Card, Empty, ErrorBox, Loading, PageHeader, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { date, datetime } from "@/lib/format";
import type { PublicationCheck, Recommendation, ReportExport } from "@/lib/types";

const UNREVIEWED: { key: keyof PublicationCheck["unreviewed"]; label: string; href: string }[] = [
  { key: "pain_points", label: "irritants", href: "pain-points" },
  { key: "opportunities", label: "opportunités", href: "opportunities" },
  { key: "assumptions", label: "hypothèses chiffrées", href: "business-case" },
  { key: "recommendations", label: "recommandations", href: "report" },
];

function size(bytes: number): string {
  return bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1000))} ko`;
}

function downloadUrl(missionId: string, exportId: string): string {
  return `/api/missions/${missionId}/exports/${exportId}/download`;
}

function PublicationCard({ check, onChanged }: { check: PublicationCheck; onChanged: () => void }) {
  const { mission, base } = useMission();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pending = UNREVIEWED.filter((u) => check.unreviewed[u.key] > 0);
  const live = mission.status === "published";

  async function run(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/missions/${mission.id}/${path}`, body);
      setAck(false);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Publication">
      {check.published_at ? (
        <div className="mb-3 rounded-xl bg-value-soft px-3 py-2 text-sm text-value">
          Publié le {date(check.published_at)} (analyse v{check.published_version}). Le client consulte cette version figée.
          {!live && <div className="mt-1 font-semibold text-check">Des modifications ont été faites depuis : republiez pour les partager.</div>}
        </div>
      ) : (
        <p className="mb-3 text-sm text-muted">
          Non publié : le client ne voit pas encore le rapport. Publier fige une version HTML + PDF sans filigrane.
        </p>
      )}
      {pending.length > 0 || check.contested > 0 ? (
        <div className="mb-3 space-y-1 text-sm">
          <div className="font-semibold">Reste à revoir avant publication</div>
          {pending.map((u) => (
            <Link key={u.key} href={`${base}/${u.href}`} className="flex justify-between rounded-lg px-2 py-1 hover:bg-gray-50">
              <span>{u.label}</span>
              <Pill tone="check">{check.unreviewed[u.key]} à vérifier</Pill>
            </Link>
          ))}
          {check.contested > 0 && (
            <div className="flex justify-between px-2 py-1">
              <span>contestations du client</span>
              <Pill tone="risk">{check.contested} ouverte(s)</Pill>
            </div>
          )}
          <label className="mt-2 flex items-start gap-2 text-xs text-muted">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            Je publie en connaissance de cause : les éléments non revus resteront marqués « à vérifier » dans le rapport.
          </label>
        </div>
      ) : (
        <div className="mb-3 text-sm text-value">Tous les éléments ont été revus.</div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || !check.analyzed || (!check.ready && !ack)}
          onClick={() => run("publish", { acknowledge_unreviewed: ack })}
        >
          <Send size={14} /> {check.published_at ? "Republier" : "Publier"}
        </Button>
        {check.published_at && (
          <Button variant="danger" disabled={busy} onClick={() => run("unpublish")}>
            <Undo2 size={14} /> Retirer
          </Button>
        )}
      </div>
      {error ? <div className="mt-3"><ErrorBox error={error} /></div> : null}
    </Card>
  );
}

export default function ReportPage() {
  const { mission, canWrite } = useMission();
  const base = `/missions/${mission.id}`;
  const { data: exports, mutate: refreshExports } = useSWR<ReportExport[]>(`${base}/exports`);
  // Bumped after each change so the framed report reloads.
  const [revision, setRevision] = useState(0);
  const { data: recs, mutate: refreshRecs } = useSWR<Recommendation[]>(canWrite ? `${base}/recommendations` : null);
  const { data: check, mutate: refreshCheck } = useSWR<PublicationCheck>(canWrite ? `${base}/publication` : null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  function refreshAll() {
    setRevision((r) => r + 1);
    void refreshExports();
    void refreshRecs();
    void refreshCheck();
    void globalMutate(base);
  }

  async function exportAs(format: "pdf" | "html") {
    setExporting(format);
    setError(null);
    try {
      const created = await api.post<ReportExport>(`${base}/exports`, { format });
      await refreshExports();
      window.location.assign(downloadUrl(mission.id, created.id));
    } catch (err) {
      setError(err);
    } finally {
      setExporting(null);
    }
  }

  const publishedPdf = exports?.find((e) => e.published && e.format === "pdf");
  const viewable = canWrite || !!exports?.some((e) => e.published && e.format === "html");
  const actions = canWrite ? (
    <>
      <a href={`/api${base}/report/html`} target="_blank" rel="noopener" className={buttonClasses()}>
        <ExternalLink size={14} /> Plein écran
      </a>
      <Button disabled={!!exporting || mission.analysis_version === 0} onClick={() => exportAs("html")}>
        <FileText size={14} /> {exporting === "html" ? "Export…" : "HTML"}
      </Button>
      <Button variant="primary" disabled={!!exporting || mission.analysis_version === 0} onClick={() => exportAs("pdf")}>
        <Download size={14} /> {exporting === "pdf" ? "Génération du PDF…" : "Exporter PDF"}
      </Button>
    </>
  ) : publishedPdf ? (
    <a href={downloadUrl(mission.id, publishedPdf.id)} className={buttonClasses("primary")}>
      <Download size={14} /> Télécharger le PDF
    </a>
  ) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Restitution"
        title="Rapport dirigeant"
        subtitle="Une version concise pour décision, avec annexes détaillées et preuves. Chaque chiffre renvoie à sa source."
        actions={actions}
      />
      {error ? <div className="mb-4"><ErrorBox error={error} /></div> : null}
      {mission.analysis_version === 0 ? (
        <Empty title="Aucune analyse pour l'instant">Importez les sources et lancez l&apos;analyse pour générer le rapport.</Empty>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0">
            {!canWrite && exports === undefined ? (
              <Loading />
            ) : !viewable ? (
              <Empty title="Le rapport n'est pas encore publié">
                Il sera disponible ici dès que le consultant l&apos;aura validé et publié.
              </Empty>
            ) : (
              // Same-origin frame, sandboxed without scripts: in-report links (#E12) stay inside the document.
              <iframe
                key={revision}
                title="Aperçu du rapport"
                sandbox=""
                src={`/api${base}/report/html?r=${revision}`}
                className="h-[calc(100vh-190px)] min-h-[600px] w-full rounded-2xl border border-line bg-white"
                data-testid="report-preview"
              />
            )}
          </div>
          <div className="space-y-4">
            {canWrite && check && <PublicationCard check={check} onChanged={refreshAll} />}
            {canWrite && (
              <Card title="Synthèse et recommandations">
                <p className="mb-3 text-xs text-muted">
                  Générées à partir des opportunités chiffrées. Vos reformulations sont conservées lors des analyses suivantes.
                </p>
                {recs ? <RecommendationsEditor items={recs} onChanged={refreshAll} /> : <Loading />}
              </Card>
            )}
            <Card title="Exports">
              {!exports?.length ? (
                <p className="text-sm text-muted">{canWrite ? "Aucun export pour l'instant." : "Aucun document publié."}</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {exports.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                      <div>
                        <div className="font-semibold uppercase">
                          {e.format} <span className="font-normal normal-case text-muted">· v{e.analysis_version} · {size(e.size_bytes)}</span>
                        </div>
                        <div className="text-xs text-muted">{datetime(e.created_at)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Pill tone={e.published ? "value" : "neutral"}>{e.published ? "Publié" : "Brouillon"}</Pill>
                        <a href={downloadUrl(mission.id, e.id)} className="text-info hover:underline" aria-label={`Télécharger ${e.format}`}>
                          <Download size={15} />
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
