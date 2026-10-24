"use client";

import useSWR from "swr";
import type { Me, Role } from "@/lib/types";

export function useMe() {
  const { data, error, isLoading, mutate } = useSWR<Me>("/auth/me");
  return { me: data, error, isLoading, mutate };
}

export function roleFor(me: Me | undefined, orgId: string | undefined): Role | undefined {
  if (!me || !orgId) return undefined;
  if (me.user.is_platform_admin) return "admin";
  return me.memberships.find((m) => m.organization_id === orgId)?.role;
}

export function canWrite(role: Role | undefined): boolean {
  return role === "admin" || role === "consultant";
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrateur",
  consultant: "Consultant",
  executive: "Dirigeant",
  business_owner: "Responsable métier",
};
