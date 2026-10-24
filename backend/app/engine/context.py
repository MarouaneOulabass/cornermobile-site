"""Analysis context: the mission's current sources, loaded once, with helpers to cite them."""

from __future__ import annotations

import re
import statistics
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.domain.enums import DocumentStatus, EvidenceKind
from app.engine.semantics import dataset_kind, map_columns
from app.models import AuditMission, DataTable, Document, Evidence, EvidenceLink

_TRUE = {"yes", "true", "oui", "y", "1", "vrai"}


def to_float(value: str) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def is_true(value: str) -> bool:
    return str(value).strip().lower() in _TRUE


@dataclass
class Dataset:
    table: DataTable
    document: Document
    kind: str | None
    label: str
    concepts: dict[str, str]

    @property
    def rows(self) -> list[list[str]]:
        return self.table.rows

    @property
    def n(self) -> int:
        return len(self.table.rows)

    def has(self, *concepts: str) -> bool:
        return all(c in self.concepts for c in concepts)

    def idx(self, concept: str) -> int:
        return self.table.columns.index(self.concepts[concept])

    def column(self, concept: str) -> str:
        return self.concepts[concept]

    def values(self, concept: str) -> list[str]:
        i = self.idx(concept)
        return [r[i] if i < len(r) else "" for r in self.rows]

    def numbers(self, concept: str) -> list[float | None]:
        return [to_float(v) for v in self.values(concept)]

    def where(self, predicate: Callable[[list[str]], bool]) -> list[int]:
        """1-based row numbers matching the predicate (row numbers are what evidence cites)."""
        return [i + 1 for i, r in enumerate(self.rows) if predicate(r)]

    def cell(self, row_number: int, concept: str) -> str:
        return self.rows[row_number - 1][self.idx(concept)]


@dataclass
class TextDoc:
    document: Document
    lines: list[str]

    def find_lines(self, pattern: str) -> list[int]:
        rx = re.compile(pattern, re.I)
        return [i + 1 for i, line in enumerate(self.lines) if rx.search(line)]


@dataclass
class AnalysisContext:
    db: Session
    mission: AuditMission
    datasets: list[Dataset] = field(default_factory=list)
    texts: list[TextDoc] = field(default_factory=list)

    @property
    def org_id(self) -> uuid.UUID:
        return self.mission.organization_id

    @classmethod
    def load(cls, db: Session, mission: AuditMission) -> AnalysisContext:
        ctx = cls(db, mission)
        docs = db.scalars(
            select(Document)
            .where(
                Document.mission_id == mission.id,
                Document.is_current.is_(True),
                Document.status == DocumentStatus.indexed,
            )
            .order_by(Document.path)
        ).all()
        for doc in docs:
            tables = db.scalars(select(DataTable).where(DataTable.document_id == doc.id)).all()
            for t in tables:
                kind = dataset_kind(t.columns)
                ctx.datasets.append(
                    Dataset(
                        t, doc, kind[0] if kind else None, kind[1] if kind else t.name, map_columns(t.columns)
                    )
                )
            if doc.file_type not in ("csv", "xlsx"):
                ctx.texts.append(TextDoc(doc, (doc.text or "").split("\n")))
        return ctx

    # --- lookups -------------------------------------------------------------------------------

    def dataset(self, kind: str) -> Dataset | None:
        return next((d for d in self.datasets if d.kind == kind), None)

    def docs_by_category(self, category: str) -> list[TextDoc]:
        return [t for t in self.texts if t.document.category == category]

    def grep(self, pattern: str, categories: Iterable[str] | None = None) -> list[tuple[TextDoc, list[int]]]:
        """Text documents whose lines match `pattern`, with the matching line numbers."""
        cats = set(categories) if categories else None
        out = []
        for t in self.texts:
            if cats and t.document.category not in cats:
                continue
            lines = t.find_lines(pattern)
            if lines:
                out.append((t, lines))
        return out

    # --- evidence ------------------------------------------------------------------------------

    def _evidence(self, doc: Document | None, kind: str, **fields) -> Evidence:
        ev = Evidence(
            organization_id=self.org_id,
            mission_id=self.mission.id,
            document_id=doc.id if doc else None,
            kind=kind,
            **fields,
        )
        self.db.add(ev)
        return ev

    def cite_rows(
        self,
        ds: Dataset,
        rows: list[int],
        columns: list[str],
        summary: str,
        detector: str,
        relevance: float = 0.8,
    ) -> Evidence:
        cols = [ds.column(c) if c in ds.concepts else c for c in columns]
        sample = rows[:5]
        idxs = [ds.table.columns.index(c) for c in cols]
        excerpt = "\n".join(
            f"ligne {n} : " + ", ".join(f"{ds.table.columns[i]}={ds.rows[n - 1][i]}" for i in idxs)
            for n in sample
        )
        return self._evidence(
            ds.document,
            EvidenceKind.rows,
            locator={
                "table_id": str(ds.table.id),
                "table": ds.table.name,
                "rows": rows[:500],
                "row_count": len(rows),
                "columns": cols,
            },
            excerpt=excerpt,
            summary=summary,
            relevance=relevance,
            detector=detector,
        )

    def cite_aggregate(
        self,
        ds: Dataset,
        summary: str,
        formula: str,
        value: dict,
        columns: list[str],
        detector: str,
        rows: list[int] | None = None,
        relevance: float = 0.9,
    ) -> Evidence:
        cols = [ds.column(c) if c in ds.concepts else c for c in columns]
        return self._evidence(
            ds.document,
            EvidenceKind.aggregate,
            locator={
                "table_id": str(ds.table.id),
                "table": ds.table.name,
                "columns": cols,
                "rows": (rows or [])[:500],
                "row_count": len(rows) if rows is not None else ds.n,
            },
            excerpt=formula,
            summary=summary,
            value=value,
            relevance=relevance,
            detector=detector,
        )

    def cite_lines(
        self, t: TextDoc, lines: list[int], summary: str, detector: str, relevance: float = 0.7
    ) -> Evidence:
        lo, hi = min(lines), max(lines)
        if hi - lo > 6:  # keep the excerpt focused on the first matches
            hi = lo + 2
        return self._evidence(
            t.document,
            EvidenceKind.excerpt,
            locator={"lines": [lo, hi]},
            excerpt="\n".join(t.lines[lo - 1 : hi]),
            summary=summary,
            relevance=relevance,
            detector=detector,
        )

    def cite_document(
        self, doc: Document, summary: str, detector: str, value: dict | None = None
    ) -> Evidence:
        return self._evidence(
            doc,
            EvidenceKind.document,
            excerpt=doc.title or doc.filename,
            summary=summary,
            value=value or {},
            relevance=0.5,
            detector=detector,
        )

    def link(self, evidence: Evidence | Iterable[Evidence], target_type: str, target_id: uuid.UUID) -> None:
        items = [evidence] if isinstance(evidence, Evidence) else list(evidence)
        self.db.flush()
        for ev in items:
            self.db.add(
                EvidenceLink(
                    organization_id=self.org_id,
                    mission_id=self.mission.id,
                    evidence_id=ev.id,
                    target_type=target_type,
                    target_id=target_id,
                )
            )


def median(values: Iterable[float | None]) -> float | None:
    clean = [v for v in values if v is not None]
    return statistics.median(clean) if clean else None


def mean(values: Iterable[float | None]) -> float | None:
    clean = [v for v in values if v is not None]
    return statistics.fmean(clean) if clean else None
