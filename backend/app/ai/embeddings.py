"""Embeddings for hybrid search.

`HashingEmbedder` is a dependency-free, deterministic feature-hashing embedder (word unigrams,
bigrams and character trigrams, accent-insensitive). It keeps the MVP self-contained and
reproducible; a neural embedder can be plugged in behind the same interface.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Protocol

from app.ingestion.classifier import normalize

DIM = 256
_TOKEN = re.compile(r"[a-z0-9]+")
STOPWORDS = frozenset(
    "le la les de des du un une et ou a au aux en dans par pour sur avec sans ce cet cette ces est sont "
    "il elle ils elles on nous vous que qui quoi dont the of and to in is are for on with by an be".split()
)


def tokens(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(normalize(text)) if t not in STOPWORDS and len(t) > 1]


class Embedder(Protocol):
    dim: int

    def embed(self, text: str) -> list[float]: ...


class HashingEmbedder:
    dim = DIM

    @staticmethod
    def _bucket(feature: str) -> tuple[int, float]:
        h = hashlib.blake2b(feature.encode(), digest_size=8).digest()
        idx = int.from_bytes(h[:4], "little") % DIM
        sign = 1.0 if h[4] & 1 else -1.0
        return idx, sign

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * DIM
        toks = tokens(text)
        # Words carry most of the signal; character trigrams add tolerance to inflections and typos.
        features = [(t, 1.0) for t in toks]
        features += [(f"{a}_{b}", 1.0) for a, b in zip(toks, toks[1:], strict=False)]
        for tok in toks:
            padded = f"#{tok}#"
            features += [(padded[i : i + 3], 0.3) for i in range(len(padded) - 2)]
        for feature, weight in features:
            idx, sign = self._bucket(feature)
            vec[idx] += sign * weight
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [round(v / norm, 5) for v in vec]


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    return sum(x * y for x, y in zip(a, b, strict=False))


def get_embedder() -> Embedder:
    return HashingEmbedder()
