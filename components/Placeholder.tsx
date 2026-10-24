"use client";

import { Empty, PageHeader } from "@/components/ui";

export function Placeholder({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} />
      <Empty title="Écran en cours de construction">Cette vue sera disponible à l&apos;étape suivante du MVP.</Empty>
    </>
  );
}
