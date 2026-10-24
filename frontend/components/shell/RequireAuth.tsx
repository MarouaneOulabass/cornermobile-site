"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loading } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/hooks/useMe";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, error } = useMe();
  const router = useRouter();
  const unauthorized = error instanceof ApiError && error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [unauthorized, router]);
  if (!me) return <Loading label={unauthorized ? "Redirection…" : "Chargement…"} />;
  return <>{children}</>;
}
