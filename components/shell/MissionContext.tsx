"use client";

import { createContext, useContext } from "react";
import type { Mission, Organization, Role } from "@/lib/types";

export interface MissionCtx {
  mission: Mission;
  organization: Organization;
  role: Role;
  canWrite: boolean;
  base: string;
}

export const MissionContext = createContext<MissionCtx | null>(null);

export function useMission(): MissionCtx {
  const ctx = useContext(MissionContext);
  if (!ctx) throw new Error("useMission must be used inside a mission page");
  return ctx;
}
