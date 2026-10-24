"""Entity extraction (spec §5.3): departments, people, tools, processes, contracts, SLAs, KPIs.

Everything extracted keeps a pointer to where it was read (table rows or document lines).
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date

from app.engine.context import AnalysisContext, Dataset, TextDoc, median, to_float
from app.engine.semantics import canonical_tool, tools_in_text
from app.ingestion.classifier import normalize


@dataclass
class Source:
    """Where a fact was read: a dataset with row numbers, or a text document with line numbers."""

    dataset: Dataset | None = None
    rows: list[int] = field(default_factory=list)
    columns: list[str] = field(default_factory=list)
    text: TextDoc | None = None
    lines: list[int] = field(default_factory=list)
    summary: str = ""


@dataclass
class DepartmentInfo:
    name: str
    headcount: int = 0
    manager: str | None = None
    tools: Counter = field(default_factory=Counter)
    tool_rows: dict[str, list[int]] = field(default_factory=lambda: defaultdict(list))


@dataclass
class OrgStructure:
    departments: dict[str, DepartmentInfo] = field(default_factory=dict)
    tools: Counter = field(default_factory=Counter)  # canonical tool -> number of primary users
    declared_systems: list[tuple[str, int]] = field(default_factory=list)  # (tool, line) from the profile
    profile: TextDoc | None = None
    employees: Dataset | None = None
    people: list[dict] = field(default_factory=list)


@dataclass
class StepInfo:
    ordinal: int
    label: str
    line: int
    tools: list[str]
    is_manual: bool
    is_reentry: bool
    requires_validation: bool


@dataclass
class ProcessInfo:
    key: str
    name: str
    origin: str  # procedure | donnees | reporting
    description: str = ""
    owner_department: str | None = None
    owner_defined: bool = True
    tools: dict[str, Source] = field(default_factory=dict)
    inputs: list[str] = field(default_factory=list)
    outputs: list[str] = field(default_factory=list)
    steps: list[StepInfo] = field(default_factory=list)
    cycle_time_minutes: float | None = None
    cycle_time_source: Source | None = None
    dataset: Dataset | None = None
    document: TextDoc | None = None
    confidence: float = 0.6
    updated: date | None = None
    vigilance: list[tuple[str, int]] = field(default_factory=list)


@dataclass
class ContractInfo:
    doc: TextDoc
    label: str
    annual_amount: float | None = None
    sla_hours: float | None = None
    sla_line: int | None = None
    penalty_pct: float | None = None
    penalty_line: int | None = None
    amount_line: int | None = None
    reporting_day: int | None = None
    reporting_line: int | None = None


@dataclass
class KpiPoint:
    doc: TextDoc
    line: int
    value: float
    unit: str


@dataclass
class KpiInfo:
    name: str
    points: list[KpiPoint] = field(default_factory=list)


@dataclass
class Extraction:
    org: OrgStructure
    processes: list[ProcessInfo]
    contracts: list[ContractInfo]
    kpis: dict[str, KpiInfo]


# Generic process templates for recognised dataset kinds: name, owner keywords, inputs, outputs.
DATASET_PROCESSES: dict[str, tuple[str, list[str], list[str], list[str]]] = {
    "quotes": (
        "Devis & commande",
        ["commercial", "adv", "vente", "commerce"],
        ["Demande client", "Catalogue / prix"],
        ["Devis", "Commande"],
    ),
    "receivables": (
        "Facturation & encaissement",
        ["finance", "comptab", "recouvrement"],
        ["Factures émises"],
        ["Encaissements", "Relances"],
    ),
    "inventory": (
        "Gestion des stocks",
        ["logistique", "supply", "achat", "magasin"],
        ["Réceptions", "Ventes"],
        ["Niveau de stock"],
    ),
    "tickets": (
        "Support client / SAV",
        ["sav", "support", "relation client", "service client"],
        ["Demandes clients"],
        ["Tickets résolus"],
    ),
    "interventions": (
        "Planification & interventions terrain",
        ["planification", "exploitation", "technicien"],
        ["Demandes d'intervention"],
        ["Interventions réalisées", "Comptes rendus"],
    ),
    "purchases": (
        "Achats & approvisionnement",
        ["achat", "supply", "approvisionnement"],
        ["Besoins en pièces"],
        ["Bons de commande"],
    ),
    "maintenance": (
        "Maintenance des équipements",
        ["maintenance"],
        ["Pannes et alertes"],
        ["Rapports de maintenance"],
    ),
    "non_conformities": (
        "Gestion de la qualité",
        ["qualite"],
        ["Contrôles qualité"],
        ["Non-conformités", "Actions correctives"],
    ),
    "production": (
        "Ordonnancement & production",
        ["production", "methodes"],
        ["Commandes", "Prévisions commerciales"],
        ["Ordres de fabrication"],
    ),
}

CYCLE_CONCEPT = {
    "quotes": ("prep_minutes", 1.0),
    "tickets": ("resolution_hours", 60.0),
    "interventions": ("resolution_hours", 60.0),
    "production": ("actual_hours", 60.0),
    "maintenance": ("downtime_hours", 60.0),
}

TOOL_COLUMNS = ("source_system", "planning_source", "channel", "report_format")

_STEP_RE = re.compile(r"^\s*(\d+)[.)]\s+(.+)$")
_DATE_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", normalize(text)).strip("-")


def _owner(org: OrgStructure, keywords: list[str]) -> str | None:
    for kw in keywords:
        for name in org.departments:
            if kw in normalize(name):
                return name
    return None


def extract_org(ctx: AnalysisContext) -> OrgStructure:
    org = OrgStructure()
    emp = ctx.dataset("employees")
    org.employees = emp
    if emp:
        for n, row in enumerate(emp.rows, start=1):
            dept = row[emp.idx("department")].strip() or "Non renseigné"
            info = org.departments.setdefault(dept, DepartmentInfo(dept))
            info.headcount += 1
            if emp.has("tool"):
                tool = canonical_tool(row[emp.idx("tool")])
                if tool:
                    info.tools[tool[0]] += 1
                    info.tool_rows[tool[0]].append(n)
                    org.tools[tool[0]] += 1
            org.people.append(
                {
                    "external_id": row[emp.idx("record_id")] if emp.has("record_id") else None,
                    "name": row[emp.idx("person_name")] if emp.has("person_name") else f"Personne {n}",
                    "department": dept,
                    "role": row[emp.idx("role")] if emp.has("role") else None,
                    "seniority": to_float(row[emp.idx("seniority_years")])
                    if emp.has("seniority_years")
                    else None,
                    "tool": canonical_tool(row[emp.idx("tool")])[0]
                    if emp.has("tool") and canonical_tool(row[emp.idx("tool")])
                    else None,
                }
            )
    chart = ctx.dataset("org_chart")
    if chart:
        for row in chart.rows:
            dept = row[chart.idx("department")].strip()
            info = org.departments.setdefault(dept, DepartmentInfo(dept))
            info.manager = row[chart.idx("manager")]
    # Systems declared in the company profile ("Systèmes existants").
    for t in ctx.texts:
        start = t.find_lines(r"^#+\s*syst[eè]mes")
        if not start:
            continue
        org.profile = t
        for line_no in range(start[0] + 1, len(t.lines) + 1):
            line = t.lines[line_no - 1]
            if line.startswith("#"):
                break
            for tool in tools_in_text(line):
                org.declared_systems.append((tool, line_no))
        break
    return org


def _parse_procedure(t: TextDoc) -> ProcessInfo | None:
    title = t.document.title or ""
    if (
        not re.search(r"proc[eé]dure|processus|mode op", normalize(title))
        and t.document.category != "procedures"
    ):
        return None
    name = re.split(r"\s+[—–-]\s+", title, maxsplit=1)[-1].strip() or title
    proc = ProcessInfo(
        key=f"process:{_slug(name)}",
        name=name[:1].upper() + name[1:],
        origin="procedure",
        document=t,
        confidence=0.8,
    )
    objective = t.find_lines(r"^#+\s*objectif")
    if objective:
        body = [
            line
            for line in t.lines[objective[0] : objective[0] + 4]
            if line.strip() and not line.startswith("#")
        ]
        proc.description = " ".join(body)[:500]
    m = _DATE_RE.search(str(t.document.meta.get("updated") or t.document.meta.get("date") or ""))
    if m:
        proc.updated = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    in_steps = False
    for n, line in enumerate(t.lines, start=1):
        if line.startswith("#"):
            in_steps = bool(re.search(r"etape", normalize(line)))
            vigilance = bool(re.search(r"vigilance|points? d.attention|risques?", normalize(line)))
            if vigilance:
                for k in range(n + 1, len(t.lines) + 1):
                    vline = t.lines[k - 1]
                    if vline.startswith("#"):
                        break
                    if vline.strip().startswith("-"):
                        proc.vigilance.append((vline.strip("- ").strip(), k))
            continue
        m = _STEP_RE.match(line)
        if in_steps and m:
            label = m.group(2).strip()
            low = normalize(label)
            tools = tools_in_text(label)
            proc.steps.append(
                StepInfo(
                    ordinal=int(m.group(1)),
                    label=label,
                    line=n,
                    tools=tools,
                    is_manual=bool(re.search(r"saisie|manuel|a la main|verification", low)),
                    is_reentry="ressaisie" in low or "re-saisie" in low,
                    requires_validation="validation" in low or "valide" in low,
                )
            )
            for tool in tools:
                proc.tools.setdefault(
                    tool, Source(text=t, lines=[n], summary=f"Étape {m.group(1)} : {label}")
                )
    for text, _ in proc.vigilance:
        if re.search(r"ne precise pas.*proprietaire|proprietaire.*non defini", normalize(text)):
            proc.owner_defined = False
    return proc


def extract_processes(ctx: AnalysisContext, org: OrgStructure) -> list[ProcessInfo]:
    processes: list[ProcessInfo] = []
    for t in ctx.docs_by_category("procedures"):
        proc = _parse_procedure(t)
        if proc and proc.steps:
            processes.append(proc)

    for ds in ctx.datasets:
        template = DATASET_PROCESSES.get(ds.kind or "")
        if not template:
            continue
        name, owners, inputs, outputs = template
        proc = ProcessInfo(
            key=f"process:{_slug(name)}",
            name=name,
            origin="donnees",
            description=f"Processus reconstitué à partir de « {ds.document.filename} » ({ds.n} enregistrements).",
            owner_department=_owner(org, owners),
            inputs=inputs,
            outputs=outputs,
            dataset=ds,
            confidence=0.75,
        )
        for concept in TOOL_COLUMNS:
            if not ds.has(concept):
                continue
            by_tool: dict[str, list[int]] = defaultdict(list)
            for n, value in enumerate(ds.values(concept), start=1):
                tool = canonical_tool(value)
                if tool:
                    by_tool[tool[0]].append(n)
            for tool, rows in by_tool.items():
                proc.tools.setdefault(
                    tool,
                    Source(
                        dataset=ds,
                        rows=rows,
                        columns=[concept],
                        summary=f"{len(rows)} enregistrements via {tool}",
                    ),
                )
        if ds.has("template"):
            xlsx = ds.where(lambda r, i=ds.idx("template"): r[i].lower().endswith((".xlsx", ".xls")))
            if xlsx:
                proc.tools.setdefault(
                    "Excel",
                    Source(
                        dataset=ds,
                        rows=xlsx,
                        columns=["template"],
                        summary=f"{len(xlsx)} enregistrements préparés sur un modèle Excel",
                    ),
                )
        if ds.kind in CYCLE_CONCEPT and ds.has(CYCLE_CONCEPT[ds.kind][0]):
            concept, factor = CYCLE_CONCEPT[ds.kind]
            med = median(ds.numbers(concept))
            if med is not None:
                proc.cycle_time_minutes = round(med * factor, 1)
                proc.cycle_time_source = Source(
                    dataset=ds, columns=[concept], summary=f"médiane de {ds.column(concept)}"
                )
        processes.append(proc)

    reports = ctx.docs_by_category("reporting")
    if reports:
        proc = ProcessInfo(
            key="process:reporting-de-direction",
            name="Reporting de direction",
            origin="reporting",
            description=f"Production des rapports mensuels ({len(reports)} rapports analysés).",
            owner_department=_owner(org, ["direction", "finance", "controle"]),
            inputs=["Fichiers opérationnels", "Exports ERP"],
            outputs=["Rapport mensuel"],
            confidence=0.7,
        )
        for t in reports:
            for n, line in enumerate(t.lines, start=1):
                for tool in tools_in_text(line):
                    proc.tools.setdefault(tool, Source(text=t, lines=[n], summary=line.strip()[:200]))
        bi_users = sum(info.tools.get("Power BI", 0) for info in org.departments.values())
        if bi_users and org.employees:
            rows = org.employees.where(
                lambda r, i=org.employees.idx("tool"): canonical_tool(r[i]) == ("Power BI", "bi")
            )
            proc.tools.setdefault(
                "Power BI",
                Source(
                    dataset=org.employees,
                    rows=rows,
                    columns=["tool"],
                    summary=f"{bi_users} collaborateurs utilisent Power BI",
                ),
            )
        processes.append(proc)

    # Same key from two origins (e.g. a documented "Validation des achats" and purchases data): keep both
    # but make keys unique.
    seen: Counter = Counter()
    for p in processes:
        seen[p.key] += 1
        if seen[p.key] > 1:
            p.key = f"{p.key}-{seen[p.key]}"
    return processes


_AMOUNT_RE = re.compile(r"montant annuel\s*:\s*([\d\s.,]+)", re.I)
_SLA_RE = re.compile(r"d[ée]lai de traitement\s*:\s*(\d+(?:[.,]\d+)?)\s*(heures?|h|jours?)", re.I)
_PENALTY_RE = re.compile(r"p[ée]nalit[ée]\s*:\s*(\d+(?:[.,]\d+)?)\s*%", re.I)
_REPORT_DAY_RE = re.compile(r"reporting.*avant le (\d{1,2})", re.I)


def _amount(text: str) -> float | None:
    digits = re.sub(r"[^\d]", "", text)
    return float(digits) if digits else None


def extract_contracts(ctx: AnalysisContext) -> list[ContractInfo]:
    contracts = []
    for t in ctx.docs_by_category("contrats"):
        c = ContractInfo(doc=t, label=t.document.title or t.document.filename)
        for n, line in enumerate(t.lines, start=1):
            if (m := _AMOUNT_RE.search(line)) and c.annual_amount is None:
                c.annual_amount, c.amount_line = _amount(m.group(1)), n
            if (m := _SLA_RE.search(line)) and c.sla_hours is None:
                value = float(m.group(1).replace(",", "."))
                c.sla_hours = value * 24 if m.group(2).lower().startswith("jour") else value
                c.sla_line = n
            if (m := _PENALTY_RE.search(line)) and c.penalty_pct is None:
                c.penalty_pct, c.penalty_line = float(m.group(1).replace(",", ".")), n
            if (m := _REPORT_DAY_RE.search(line)) and c.reporting_day is None:
                c.reporting_day, c.reporting_line = int(m.group(1)), n
        if c.annual_amount or c.sla_hours or c.penalty_pct:
            contracts.append(c)
    return contracts


_KPI_RE = re.compile(
    r"^\s*[-*]\s*([^:]{2,60})\s*:\s*([\d.,]+)\s*(M MAD|k MAD|MAD|%|dossiers?|jours?|h)?", re.I
)


def extract_kpis(ctx: AnalysisContext) -> dict[str, KpiInfo]:
    kpis: dict[str, KpiInfo] = {}
    for t in ctx.docs_by_category("reporting"):
        for n, line in enumerate(t.lines, start=1):
            m = _KPI_RE.match(line)
            if not m:
                continue
            value = to_float(m.group(2))
            if value is None:
                continue
            name = m.group(1).strip()
            kpis.setdefault(name, KpiInfo(name)).points.append(
                KpiPoint(t, n, value, (m.group(3) or "").strip())
            )
    return kpis


def extract(ctx: AnalysisContext) -> Extraction:
    org = extract_org(ctx)
    return Extraction(org, extract_processes(ctx, org), extract_contracts(ctx), extract_kpis(ctx))
