"use client";

import { Pill, type Tone } from "@/components/ui";
import { CRITICALITY_LABELS, NATURE_LABELS, VALIDATION_LABELS } from "@/lib/labels";
import type { ValidationStatus } from "@/lib/types";

export function NatureBadge({ nature }: { nature: string }) {
  const [label, tone, title] = NATURE_LABELS[nature] ?? [nature, "neutral" as Tone, ""];
  return (
    <Pill tone={tone} title={title}>
      {label}
    </Pill>
  );
}

export function ConfidenceBadge({ value }: { value: number }) {
  const tone: Tone = value >= 0.8 ? "value" : value >= 0.6 ? "info" : "check";
  return (
    <Pill tone={tone} title="Niveau de confiance de l'analyse">
      confiance {Math.round(value * 100)} %
    </Pill>
  );
}

export function CriticalityBadge({ value }: { value: string }) {
  const [label, tone] = CRITICALITY_LABELS[value] ?? [value, "neutral" as Tone];
  return <Pill tone={tone}>{label}</Pill>;
}

export function StatusBadge({ value }: { value: ValidationStatus }) {
  const [label, tone] = VALIDATION_LABELS[value];
  return <Pill tone={tone}>{label}</Pill>;
}

export function HypothesisBadge() {
  return (
    <Pill tone="check" title="Aucune source ne l'établit directement">
      Hypothèse à valider
    </Pill>
  );
}
