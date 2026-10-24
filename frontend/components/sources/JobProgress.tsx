"use client";

import { useEffect } from "react";
import useSWR from "swr";
import { Bar, Pill } from "@/components/ui";
import type { Job } from "@/lib/types";

export function JobProgress({ missionId, jobId, onDone }: { missionId: string; jobId: string; onDone?: (job: Job) => void }) {
  const { data: job } = useSWR<Job>(`/missions/${missionId}/jobs/${jobId}`, {
    refreshInterval: (j) => (j && (j.status === "done" || j.status === "error") ? 0 : 800),
  });
  const finished = job?.status === "done" || job?.status === "error";
  useEffect(() => {
    if (job && finished) onDone?.(job);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);
  if (!job) return null;
  return (
    <div className="rounded-xl border border-line bg-white p-3" data-testid="job-progress">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{job.kind === "ingest" ? "Import et indexation" : job.kind === "analyze" ? "Analyse" : "Export"}</span>
        <Pill tone={job.status === "error" ? "risk" : finished ? "value" : "info"}>
          {job.status === "error" ? "Échec" : finished ? "Terminé" : `${Math.round(job.progress)} %`}
        </Pill>
      </div>
      <Bar value={job.progress / 100} tone={job.status === "error" ? "risk" : finished ? "value" : "info"} />
      <div className="mt-1.5 text-xs text-muted">{job.error ?? job.message}</div>
    </div>
  );
}
