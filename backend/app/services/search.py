"""Hybrid search with mandatory citations (spec §11): BM25 lexical + vector cosine, fused by RRF."""

from __future__ import annotations

import math
import re
import uuid
from collections import Counter
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.embeddings import cosine, get_embedder, tokens
from app.models import Document, DocumentChunk

RRF_K = 60


@dataclass
class SearchHit:
    document_id: uuid.UUID
    filename: str
    path: str
    category: str | None
    chunk_id: uuid.UUID
    start_line: int
    end_line: int
    excerpt: str
    score: float
    lexical_rank: int | None
    vector_rank: int | None


def _bm25(query: list[str], docs: list[list[str]], k1: float = 1.4, b: float = 0.75) -> list[float]:
    n = len(docs)
    avgdl = sum(len(d) for d in docs) / n if n else 0
    df = Counter(t for d in docs for t in set(d))
    scores = []
    for d in docs:
        tf = Counter(d)
        s = 0.0
        for t in query:
            if t not in tf:
                continue
            idf = math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5))
            s += idf * tf[t] * (k1 + 1) / (tf[t] + k1 * (1 - b + b * len(d) / (avgdl or 1)))
        scores.append(s)
    return scores


_HEADER_LINE = re.compile(r"^(from|to|cc|subject|date|de|objet)\s*:", re.I)


def _best_excerpt(text: str, query: list[str], start_line: int, width: int = 3) -> tuple[str, int, int]:
    """Narrow a chunk to the few lines that best match the query, keeping exact line numbers."""
    lines = text.split("\n")
    if len(lines) <= width:
        return text, start_line, start_line + len(lines) - 1
    qs = set(query)
    best_i, best = 0, -1.0
    for i, line in enumerate(lines):
        score = len(qs & set(tokens(line))) - (0.5 if _HEADER_LINE.match(line) else 0)
        if score > best:
            best_i, best = i, score
    lo = max(0, min(best_i - 1, len(lines) - width))
    hi = min(len(lines), lo + width)
    while lo < hi and not lines[lo].strip():
        lo += 1
    while hi > lo + 1 and not lines[hi - 1].strip():
        hi -= 1
    return "\n".join(lines[lo:hi]), start_line + lo, start_line + hi - 1


def search(
    db: Session, mission_id: uuid.UUID, query: str, limit: int = 10, category: str | None = None
) -> list[SearchHit]:
    q_tokens = tokens(query)
    if not q_tokens:
        return []
    stmt = (
        select(DocumentChunk, Document)
        .join(Document, Document.id == DocumentChunk.document_id)
        .where(DocumentChunk.mission_id == mission_id, Document.is_current.is_(True))
    )
    if category:
        stmt = stmt.where(Document.category == category)
    rows = db.execute(stmt).all()
    if not rows:
        return []
    chunk_tokens = [tokens(f"{doc.title or ''} {chunk.text}") for chunk, doc in rows]
    lexical = _bm25(q_tokens, chunk_tokens)
    q_vec = get_embedder().embed(query)
    vector = [cosine(q_vec, chunk.embedding) for chunk, _ in rows]

    lex_order = [i for i in sorted(range(len(rows)), key=lambda i: -lexical[i]) if lexical[i] > 0]
    top_vec = max(vector)
    floor = max(0.12, 0.6 * top_vec)  # vector-only matches must be clearly similar, not noise
    vec_order = [i for i in sorted(range(len(rows)), key=lambda i: -vector[i]) if vector[i] >= floor]
    lex_rank = {i: r for r, i in enumerate(lex_order, start=1)}
    vec_rank = {i: r for r, i in enumerate(vec_order[: max(50, limit * 5)], start=1)}
    fused = Counter()
    for i, r in lex_rank.items():
        fused[i] += 1 / (RRF_K + r)
    for i, r in vec_rank.items():
        fused[i] += 1 / (RRF_K + r)

    hits = []
    seen_docs: Counter = Counter()
    ranked = fused.most_common()
    cutoff = ranked[0][1] * 0.5 if ranked else 0
    for i, score in ranked:
        if score < cutoff:  # weak, vector-only tail: noise rather than evidence
            break
        chunk, doc = rows[i]
        if seen_docs[doc.id] >= 2:  # keep results diverse across documents
            continue
        seen_docs[doc.id] += 1
        excerpt, start, end = _best_excerpt(chunk.text, q_tokens, chunk.start_line)
        hits.append(
            SearchHit(
                document_id=doc.id,
                filename=doc.filename,
                path=doc.path,
                category=doc.category,
                chunk_id=chunk.id,
                start_line=start,
                end_line=end,
                excerpt=excerpt,
                score=round(score, 5),
                lexical_rank=lex_rank.get(i),
                vector_rank=vec_rank.get(i),
            )
        )
        if len(hits) >= limit:
            break
    return hits
