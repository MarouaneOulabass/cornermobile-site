"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import useSWR from "swr";
import { useMission } from "@/components/shell/MissionContext";
import { Empty, Loading, PageHeader } from "@/components/ui";
import type { Opportunity } from "@/lib/types";

/** "Business case" in the navigation opens the top-priority opportunity. */
export default function BusinessCaseIndex() {
  const { mission, base } = useMission();
  const router = useRouter();
  const { data } = useSWR<Opportunity[]>(`/missions/${mission.id}/opportunities?sort=priority`);
  const top = data?.find((o) => o.validation_status !== "rejete");
  useEffect(() => {
    if (top) router.replace(`${base}/opportunities/${top.id}`);
  }, [top, base, router]);
  if (!data || top) return <Loading />;
  return (
    <>
      <PageHeader eyebrow="Business case" title="Aucun business case" />
      <Empty title="Aucune opportunité">Lancez l&apos;analyse pour générer les business cases.</Empty>
    </>
  );
}
