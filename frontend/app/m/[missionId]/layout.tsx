"use client";

import { use } from "react";
import { MissionShell } from "@/components/shell/MissionShell";
import { RequireAuth } from "@/components/shell/RequireAuth";

export default function MissionLayout({ children, params }: { children: React.ReactNode; params: Promise<{ missionId: string }> }) {
  const { missionId } = use(params);
  return (
    <RequireAuth>
      <MissionShell missionId={missionId}>{children}</MissionShell>
    </RequireAuth>
  );
}
