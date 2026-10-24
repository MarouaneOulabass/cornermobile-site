/**
 * Reference values recomputed from the raw CSV files with a separate reader and plain arithmetic.
 *
 * This is a second, independent implementation of the key facts the engine reports: if the engine's column
 * mapping, filtering or arithmetic drifts, the two disagree. Each anchor names the engine metric it checks by a
 * fragment of its label.
 */
import path from "node:path";
import { mean, median, sum } from "../server/lib/py";
import { dictRows, readText } from "./csv";

type Row = Record<string, string>;

const cache = new Map<string, Row[]>();

function rows(folder: string, name: string): Row[] {
  const file = path.join(folder, "data", name);
  if (!cache.has(file)) cache.set(file, dictRows(readText(file)));
  return cache.get(file) as Row[];
}

/** Python's float(value), with an empty cell read as 0. */
function num(value: string | undefined): number {
  if (value === "" || value === undefined) return 0;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`could not convert string to float: '${value}'`);
  return n;
}

function share(items: Row[], predicate: (r: Row) => boolean): number {
  return items.filter(predicate).length / items.length;
}

function distinct(items: Row[], column: string): number {
  return new Set(items.map((r) => r[column])).size;
}

export interface Anchor {
  label: string; // fragment of the engine metric label
  description: string; // how the reference is computed
  compute: (folder: string) => number;
  tolerance: number; // relative
}

function A(label: string, description: string, compute: (folder: string) => number): Anchor {
  return { label, description, compute, tolerance: 0.005 };
}

const yes = (v: string) => v.toLowerCase() === "yes";
const overdue = (f: string) => rows(f, "invoices.csv").filter((r) => r.status.toUpperCase() === "OVERDUE");

const INVOICES = [
  A("Montant des créances échues", "Σ amount_mad | status = OVERDUE", (f) => sum(overdue(f).map((r) => num(r.amount_mad)))),
  A("Part des factures échues", "count(status = OVERDUE) / count(*)", (f) => share(rows(f, "invoices.csv"), (r) => r.status.toUpperCase() === "OVERDUE")),
  A("Créances échues depuis 60 jours", "Σ amount_mad | OVERDUE et days_overdue ≥ 60", (f) =>
    sum(overdue(f).filter((r) => num(r.days_overdue) >= 60).map((r) => num(r.amount_mad))),
  ),
];
const TICKETS = [
  A("Canaux d'entrée", "count(distinct channel)", (f) => distinct(rows(f, "tickets.csv"), "channel")),
  A("Tickets avec historique manquant", "count(observed_issue = Missing history) / count(*)", (f) =>
    share(rows(f, "tickets.csv"), (r) => r.observed_issue === "Missing history"),
  ),
  A("Délai médian de résolution", "median(resolution_hours)", (f) => median(rows(f, "tickets.csv").map((r) => num(r.resolution_hours)))),
];

export const ANCHORS: Record<string, Anchor[]> = {
  "atlaspro-distribution": [
    A("Part de devis ressaisis", "count(manual_reentry = yes) / count(*)", (f) => share(rows(f, "quotes.csv"), (r) => yes(r.manual_reentry))),
    A("Modèles différents", "count(distinct template_used)", (f) => distinct(rows(f, "quotes.csv"), "template_used")),
    A("Temps médian de préparation", "median(prep_minutes)", (f) => median(rows(f, "quotes.csv").map((r) => num(r.prep_minutes)))),
    A("Valeur du stock dormant", "Σ stock_value_mad | days_since_last_sale ≥ 180", (f) =>
      sum(
        rows(f, "inventory.csv")
          .filter((r) => num(r.days_since_last_sale) >= 180)
          .map((r) => num(r.stock_value_mad)),
      ),
    ),
    A("Taux de transformation", "count(Won) / count(Won ∪ Lost)", (f) =>
      share(
        rows(f, "quotes.csv").filter((r) => r.status === "Won" || r.status === "Lost"),
        (r) => r.status === "Won",
      ),
    ),
    ...INVOICES,
    ...TICKETS,
  ],
  "darna-facility-services": [
    A("Part des interventions hors SLA", "count(sla_breached = yes) / count(*)", (f) => share(rows(f, "interventions.csv"), (r) => yes(r.sla_breached))),
    A("Dépassement moyen", "mean(actual − sla | sla_breached = yes)", (f) =>
      mean(
        rows(f, "interventions.csv")
          .filter((r) => yes(r.sla_breached))
          .map((r) => num(r.actual_resolution_hours) - num(r.sla_hours)),
      ),
    ),
    A("Part planifiée hors outil", "count(planning_source ∈ {Excel, WhatsApp, Phone}) / count(*)", (f) =>
      share(rows(f, "interventions.csv"), (r) => ["Excel", "WhatsApp", "Phone"].includes(r.planning_source)),
    ),
    A("Part des achats urgents", "count(urgent_purchase = yes) / count(*)", (f) => share(rows(f, "purchases.csv"), (r) => yes(r.urgent_purchase))),
    A("Surcoût moyen des achats urgents", "mean(price_premium_pct | urgent)", (f) =>
      mean(
        rows(f, "purchases.csv")
          .filter((r) => yes(r.urgent_purchase))
          .map((r) => num(r.price_premium_pct)),
      ),
    ),
    A("Factures établies hors ERP", "count(source ≠ ERP) / count(*)", (f) => share(rows(f, "invoices.csv"), (r) => r.source !== "ERP")),
    ...INVOICES,
    ...TICKETS,
  ],
  "maghrebpack-industries": [
    A("Pannes sans cause racine", "count(root_cause_known = no) / count(*)", (f) =>
      share(rows(f, "maintenance.csv"), (r) => r.root_cause_known.toLowerCase() === "no"),
    ),
    A("Heures d'arrêt totales", "Σ downtime_hours", (f) => sum(rows(f, "maintenance.csv").map((r) => num(r.downtime_hours)))),
    A("Non-conformités répétées", "count(repeat_within_90d = yes) / count(*)", (f) => share(rows(f, "non_conformities.csv"), (r) => yes(r.repeat_within_90d))),
    A("Replanifications moyennes", "mean(replans)", (f) => mean(rows(f, "production_orders.csv").map((r) => num(r.replans)))),
    A("Dérive des temps réels", "(Σ actual_hours − Σ planned_hours) / Σ planned_hours", (f) => {
      const orders = rows(f, "production_orders.csv");
      const planned = sum(orders.map((r) => num(r.planned_hours)));
      return (sum(orders.map((r) => num(r.actual_hours))) - planned) / planned;
    }),
    A("Taux de rebut matière moyen", "mean(material_waste_pct)", (f) => mean(rows(f, "production_orders.csv").map((r) => num(r.material_waste_pct)))),
    ...INVOICES,
    ...TICKETS,
  ],
};
