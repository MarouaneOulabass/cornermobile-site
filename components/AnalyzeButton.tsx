"use client";

import { Play } from "lucide-react";
import { useState } from "react";
import { mutate } from "swr";
import { useMission } from "@/components/shell/MissionContext";
import { JobProgress } from "@/components/sources/JobProgress";
import { Button, ErrorBox } from "@/components/ui";
import { api } from "@/lib/api";

export function AnalyzeButton({ label = "Lancer l'analyse", variant = "primary" }: { label?: string; variant?: "primary" | "default" }) {
  const { mission, canWrite } = useMission();
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!canWrite) return null;
  async function start() {
    setError(null);
    try {
      const { job_id } = await api.post<{ job_id: string }>(`/missions/${mission.id}/analyze`);
      setJobId(job_id);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <div className="space-y-2">
      <Button variant={variant} onClick={start} disabled={!!jobId}>
        <Play size={14} /> {label}
      </Button>
      {jobId && (
        <JobProgress
          missionId={mission.id}
          jobId={jobId}
          onDone={() => {
            setJobId(null);
            mutate((key) => typeof key === "string" && (key.startsWith(`/missions/${mission.id}`) || key === "/portfolio"));
          }}
        />
      )}
      {error ? <ErrorBox error={error} /> : null}
    </div>
  );
}
