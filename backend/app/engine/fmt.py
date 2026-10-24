"""French number formatting for generated text (the UI formats numbers itself)."""

from __future__ import annotations


def n0(value: float) -> str:
    return f"{value:,.0f}".replace(",", " ")


def n1(value: float) -> str:
    return f"{value:,.1f}".replace(",", " ").replace(".", ",")


def pct(ratio: float, digits: int = 1) -> str:
    return f"{ratio * 100:.{digits}f}".replace(".", ",") + " %"


def mad(value: float) -> str:
    if abs(value) >= 1_000_000:
        return f"{value / 1_000_000:.2f}".replace(".", ",") + " M MAD"
    if abs(value) >= 10_000:
        return f"{n0(value / 1000)} k MAD"
    return f"{n0(value)} MAD"
