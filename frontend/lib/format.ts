const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

/** 1 400 000 → "1,40 M MAD", 210 000 → "210 k MAD". Narrow no-break spaces are normalised. */
export function mad(value: number | null | undefined, opts: { compact?: boolean } = { compact: true }): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  if (opts.compact !== false) {
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(".", ",")} M MAD`;
    if (abs >= 10_000) return `${nf0.format(Math.round(value / 1000))} k MAD`;
  }
  return `${nf0.format(Math.round(value))} MAD`.replace(/ /g, " ");
}

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return (digits === 0 ? nf0 : nf1).format(value).replace(/ /g, " ");
}

export function pct(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(digits).replace(".", ",")} %`;
}

export function months(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1).replace(".", ",")} mois`;
}

export function date(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function datetime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Format an engine metric according to its unit. */
export function metricValue(value: number, unit: string): string {
  switch (unit) {
    case "ratio":
      return pct(value, 1);
    case "MAD":
      return mad(value);
    case "MAD/an":
      return `${mad(value)}/an`;
    case "%":
      return `${num(value, 1)} %`;
    case "/an":
      return `${pct(value, 0)}/an`;
    case "":
      return num(value, value % 1 ? 1 : 0);
    default:
      return `${num(value, value % 1 ? 1 : 0)} ${unit}`;
  }
}
