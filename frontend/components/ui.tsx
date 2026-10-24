"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect } from "react";

export type Tone = "info" | "value" | "check" | "risk" | "neutral";

const toneClasses: Record<Tone, string> = {
  info: "bg-info-soft text-info",
  value: "bg-value-soft text-value",
  check: "bg-check-soft text-check",
  risk: "bg-risk-soft text-risk",
  neutral: "bg-gray-100 text-gray-700",
};

export function Pill({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex h-max items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold", toneClasses[tone], className)}>
      {children}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "default" | "ghost" | "danger"; size?: "sm" | "md" };

export function Button({ variant = "default", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg border font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
        variant === "primary" && "border-info bg-info text-white hover:bg-blue-700",
        variant === "default" && "border-line bg-white text-ink hover:bg-gray-50",
        variant === "ghost" && "border-transparent bg-transparent text-ink hover:bg-gray-100",
        variant === "danger" && "border-risk bg-white text-risk hover:bg-risk-soft",
        className,
      )}
    />
  );
}

export function Card({ children, className, title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={clsx("card", className)}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-[15px] font-bold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, onClick, tone }: { label: string; value: ReactNode; hint?: ReactNode; onClick?: () => void; tone?: Tone }) {
  const content = (
    <>
      <div className="eyebrow">{label}</div>
      <div className={clsx("my-1.5 text-[26px] font-extrabold leading-tight", tone === "value" && "text-value", tone === "risk" && "text-risk")}>{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="card text-left transition hover:border-info" title="Voir la provenance">
        {content}
      </button>
    );
  }
  return <div className="card">{content}</div>;
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow: string; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="my-1 text-[26px] font-extrabold leading-tight">{title}</h1>
        {subtitle && <div className="max-w-3xl text-sm text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Bar({ value, tone = "info" }: { value: number; tone?: Tone }) {
  const color = { info: "bg-info", value: "bg-value", check: "bg-check", risk: "bg-risk", neutral: "bg-gray-400" }[tone];
  return (
    <div className="h-2 overflow-hidden rounded-full bg-gray-200" role="meter" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i className={clsx("block h-full", color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Drawer({ open, onClose, title, children, width = "max-w-xl" }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
      <button type="button" aria-label="Fermer" className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={clsx("relative flex h-full w-full flex-col bg-panel shadow-2xl", width)}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-gray-100" aria-label="Fermer">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white/60 px-6 py-10 text-center">
      <div className="font-semibold">{title}</div>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Loading({ label = "Chargement…" }: { label?: string }) {
  return <div className="py-10 text-center text-sm text-muted">{label}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "Erreur inattendue";
  return <div className="rounded-xl border border-risk/30 bg-risk-soft px-4 py-3 text-sm text-risk">{message}</div>;
}
