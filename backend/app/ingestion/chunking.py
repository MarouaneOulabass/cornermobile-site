from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Chunk:
    ordinal: int
    text: str
    start_line: int  # 1-based, inclusive
    end_line: int


def chunk_lines(text: str, max_lines: int = 30, max_chars: int = 1500, overlap: int = 3) -> list[Chunk]:
    """Split on line boundaries so every chunk maps back to exact source lines (citations)."""
    lines = text.split("\n")
    chunks: list[Chunk] = []
    start = 0
    while start < len(lines):
        end, size = start, 0
        while end < len(lines) and end - start < max_lines and size + len(lines[end]) <= max_chars:
            size += len(lines[end]) + 1
            end += 1
        if end == start:  # a single very long line
            end = start + 1
        lo, hi = start, end
        while lo < hi and not lines[lo].strip():
            lo += 1
        while hi > lo and not lines[hi - 1].strip():
            hi -= 1
        if hi > lo:  # line numbers stay exact after trimming blank edges
            chunks.append(Chunk(len(chunks), "\n".join(lines[lo:hi]), lo + 1, hi))
        if end >= len(lines):
            break
        start = max(end - overlap, start + 1)
    return chunks
