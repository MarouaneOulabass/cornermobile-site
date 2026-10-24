"use client";

import { AlertTriangle, Building2, Plus } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { RequireAuth } from "@/components/shell/RequireAuth";
import { UserMenu } from "@/components/shell/UserMenu";
import { Bar, Empty, ErrorBox, Loading, PageHeader, Pill } from "@/components/ui";
import { mad, pct } from "@/lib/format";
import { canWrite, ROLE_LABELS, useMe } from "@/lib/hooks/useMe";
import { STATUS_LABELS } from "@/lib/labels";
import type { PortfolioCard } from "@/lib/types";


function Portfolio() {
  const { me } = useMe();
  const { data, error, isLoading } = useSWR<PortfolioCard[]>("/portfolio");
  const isConsultant = me?.user.is_platform_admin || me?.memberships.some((m) => canWrite(m.role));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
      <div className="mb-8 flex items-center justify-between">
        <div className="text-xl font-extrabold">
          Audit<span className="text-info">Flow</span>
        </div>
        <UserMenu />
      </div>
      <PageHeader
        eyebrow="Portefeuille"
        title="Missions d'audit"
        subtitle="Chaque mission transforme documents, données et entretiens en un diagnostic traçable, chiffré et priorisé."
        actions={
          isConsultant && (
            <Link href="/new" className="inline-flex items-center gap-1.5 rounded-lg border border-info bg-info px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              <Plus size={16} /> Nouvelle mission
            </Link>
          )
        }
      />
      {error && <ErrorBox error={error} />}
      {isLoading && <Loading />}
      {data && data.length === 0 && <Empty title="Aucune mission accessible">Demandez à un consultant de vous inviter.</Empty>}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {data?.map((card) => {
          const status = card.mission ? STATUS_LABELS[card.mission.status] : (["Sans mission", "neutral"] as const);
          const href = card.mission ? `/m/${card.mission.id}` : "#";
          return (
            <Link key={card.organization.id} href={href} className="card flex flex-col gap-3 transition hover:border-info" data-testid="portfolio-card">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-info-soft text-info">
                    <Building2 size={18} />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-bold">{card.organization.name}</div>
                    <div className="truncate text-xs text-muted">
                      {[card.organization.sector, card.organization.city, card.organization.employees && `${card.organization.employees} collaborateurs`].filter(Boolean).join(" — ")}
                    </div>
                  </div>
                </div>
                <Pill tone={status[1]}>{status[0]}</Pill>
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs text-muted">
                  <span>Progression</span>
                  <span>{pct(card.stats.progress)}</span>
                </div>
                <Bar value={card.stats.progress} />
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-lg font-extrabold text-value">{card.stats.annual_value_mad ? mad(card.stats.annual_value_mad) : "—"}</div>
                  <div className="text-[11px] text-muted">valeur identifiée / an</div>
                </div>
                <div>
                  <div className="text-lg font-extrabold">{card.stats.documents}</div>
                  <div className="text-[11px] text-muted">sources</div>
                </div>
                <div>
                  <div className="text-lg font-extrabold">{card.stats.pain_points}</div>
                  <div className="text-[11px] text-muted">irritants</div>
                </div>
              </div>
              {card.stats.alerts.length > 0 && (
                <ul className="space-y-1 border-t border-line pt-2 text-xs text-check">
                  {card.stats.alerts.map((a) => (
                    <li key={a} className="flex items-center gap-1.5">
                      <AlertTriangle size={13} /> {a}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-auto text-xs text-muted">Votre rôle : {ROLE_LABELS[card.role]}</div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <RequireAuth>
      <Portfolio />
    </RequireAuth>
  );
}
