"use client";

import clsx from "clsx";
import {
  BarChart3,
  Briefcase,
  ClipboardList,
  FileText,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  Lightbulb,
  Map as MapIcon,
  Settings,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { ExecSummaryDrawer } from "@/components/shell/ExecSummaryDrawer";
import { MissionContext } from "@/components/shell/MissionContext";
import { UserMenu } from "@/components/shell/UserMenu";
import { Button, ErrorBox, Loading } from "@/components/ui";
import { canWrite, ROLE_LABELS, roleFor, useMe } from "@/lib/hooks/useMe";
import type { Mission, Organization, PortfolioCard } from "@/lib/types";

const NAV = [
  { href: "", label: "Vue entreprise", icon: LayoutDashboard },
  { href: "/onboarding", label: "Mission", icon: ClipboardList, writeOnly: true },
  { href: "/sources", label: "Sources", icon: FolderOpen },
  { href: "/processes", label: "Processus", icon: GitBranch },
  { href: "/pain-points", label: "Irritants", icon: TriangleAlert },
  { href: "/opportunities", label: "Opportunités", icon: Lightbulb },
  { href: "/business-case", label: "Business case", icon: Briefcase },
  { href: "/roadmap", label: "Roadmap", icon: MapIcon },
  { href: "/report", label: "Rapport", icon: FileText },
  { href: "/settings", label: "Paramètres", icon: Settings, writeOnly: true },
];

export function MissionShell({ missionId, children }: { missionId: string; children: React.ReactNode }) {
  const { me } = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const { data: mission, error } = useSWR<Mission>(`/missions/${missionId}`);
  const { data: org } = useSWR<Organization>(mission ? `/orgs/${mission.organization_id}` : null);
  const { data: portfolio } = useSWR<PortfolioCard[]>("/portfolio");

  if (error) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <ErrorBox error={error} />
        <Link href="/" className="mt-4 inline-block text-sm text-info hover:underline">
          ← Retour au portefeuille
        </Link>
      </div>
    );
  }
  if (!mission || !org || !me) return <Loading />;

  const role = roleFor(me, org.id) ?? "executive";
  const writable = canWrite(role);
  const base = `/m/${missionId}`;
  const ctx = { mission, organization: org, role, canWrite: writable, base };

  return (
    <MissionContext.Provider value={ctx}>
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[240px_1fr]">
        <div className="no-print bg-nav">
        <aside className="px-4 py-5 text-white lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto">
          <Link href="/" className="mx-2.5 mb-5 block text-xl font-extrabold">
            Audit<span className="text-blue-300">Flow</span>
          </Link>
          <div className="mb-5 rounded-xl bg-nav-2 p-3">
            <label htmlFor="mission-switch" className="block text-xs text-gray-400">
              Mission active
            </label>
            <select
              id="mission-switch"
              className="mt-1.5 w-full rounded-lg border border-gray-700 bg-nav px-2 py-2 text-sm text-white"
              value={mission.id}
              onChange={(e) => {
                const suffix = pathname.slice(base.length).split("/").slice(0, 2).join("/");
                router.push(`/m/${e.target.value}${suffix.startsWith("/opportunities/") ? "/opportunities" : suffix}`);
              }}
            >
              {(portfolio ?? [{ organization: org, mission } as PortfolioCard])
                .filter((c) => c.mission)
                .map((c) => (
                  <option key={c.mission!.id} value={c.mission!.id}>
                    {c.organization.name}
                  </option>
                ))}
            </select>
            <div className="mt-1.5 text-[11px] text-gray-400">{ROLE_LABELS[role]}</div>
          </div>
          <nav className="flex flex-col gap-0.5" aria-label="Navigation de la mission">
            {NAV.filter((n) => !n.writeOnly || writable).map(({ href, label, icon: Icon }) => {
              const target = base + href;
              const active = href === "" ? pathname === base : pathname.startsWith(target) || (href === "/business-case" && /\/opportunities\/[^/]+$/.test(pathname));
              return (
                <Link
                  key={href}
                  href={target}
                  className={clsx("flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm", active ? "bg-nav-hover text-white" : "text-gray-300 hover:bg-nav-hover hover:text-white")}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={16} /> {label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-6 border-t border-gray-800 pt-4">
            <UserMenu dark />
          </div>
        </aside>
        </div>
        <main className="min-w-0 px-4 py-6 sm:px-8">
          <div className="no-print mb-4 flex justify-end">
            <Button size="sm" onClick={() => setSummaryOpen(true)}>
              <BarChart3 size={14} /> Résumé exécutif
            </Button>
          </div>
          {children}
        </main>
      </div>
      <ExecSummaryDrawer open={summaryOpen} onClose={() => setSummaryOpen(false)} />
    </MissionContext.Provider>
  );
}
