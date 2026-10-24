"""Evaluation harness (spec §14). The only code allowed to read the demo kit's answer key.

The engine never sees `ground_truth.json` (ingestion excludes it); the harness runs the normal
pipeline on each company, then grades what came out against the key and against independent
recomputations from the raw files.
"""
