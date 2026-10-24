"""Lexical matching between the answer key and the engine's output, plus French number parsing."""

from __future__ import annotations

import re
import unicodedata

STOPWORDS = frozenset(
    """
    a au aux avec ce ces dans de des du en et la le les leur leurs mal non ou par pas pour plus que qui sans
    se sur un une est sont depuis entre tres trop selon apres avant via vers chaque sous the of and to on
    """.split()
)

# Domain of a planted issue -> words the engine uses for the same area (grader-side vocabulary).
DOMAIN_WORDS = {
    "commercial": "commercial devis vente",
    "sales": "commercial vente prevision",
    "finance": "finance factur creance impaye",
    "inventory": "stock logistique",
    "reporting": "reporting direction",
    "support": "support sav ticket",
    "operations": "operation intervention terrain planification",
    "procurement": "achat",
    "production": "production planification",
    "maintenance": "maintenance panne",
    "quality": "qualite conformite",
}


def strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def stems(text: str) -> set[str]:
    """Accent-free, lowercase tokens truncated to 5 characters (robust light stemming for French)."""
    tokens = re.findall(r"[a-z0-9]+", strip_accents(text.lower()))
    return {t[:5] for t in tokens if len(t) > 2 and t not in STOPWORDS}


def similarity(reference_title: str, reference_text: str, candidate: str, domain: str | None = None) -> float:
    """Weighted share of the reference's stems found in the candidate (title stems count double)."""
    title, body = stems(reference_title), stems(reference_text) - stems(reference_title)
    found = stems(candidate)
    total = 2 * len(title) + len(body)
    if total == 0:
        return 0.0
    score = (2 * len(title & found) + len(body & found)) / total
    if domain and stems(DOMAIN_WORDS.get(domain, domain)) & found:
        score += 0.1
    return round(min(score, 1.0), 3)


def assign(scores: dict[tuple[int, int], float], threshold: float) -> dict[int, tuple[int, float]]:
    """Greedy one-to-one assignment of references to candidates, best pairs first."""
    taken_ref, taken_cand, out = set(), set(), {}
    for (ref, cand), score in sorted(scores.items(), key=lambda kv: -kv[1]):
        if score < threshold or ref in taken_ref or cand in taken_cand:
            continue
        out[ref] = (cand, score)
        taken_ref.add(ref)
        taken_cand.add(cand)
    return out


_NUMBER = re.compile(
    r"(?<![\w.,-])(\d{1,3}(?:[   ]\d{3})+|\d+)(?:,(\d+))?(?:\s?(M|k)(?=\s?MAD|\b))?(?![\w-]|,\d)"
)
_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{4}\b")


def numbers(text: str) -> list[tuple[str, float, float]]:
    """Numbers as displayed in French narrative text: (token, value, display tolerance)."""
    text = _DATE.sub(" ", text)
    out = []
    for m in _NUMBER.finditer(text):
        integer, decimals, mult = m.group(1), m.group(2), m.group(3)
        value = float(re.sub(r"\D", "", integer) + ("." + decimals if decimals else ""))
        factor = {"M": 1e6, "k": 1e3}.get(mult or "", 1.0)
        tolerance = 0.5 * 10 ** (-len(decimals or "")) * factor
        out.append((m.group(0).strip(), value * factor, tolerance))
    return out
