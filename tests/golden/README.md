# Golden files

Reference outputs of the original Python implementation of AuditFlow, kept to prove the TypeScript port reproduces
it exactly on the demo kit:

- `<company>.json` — everything the engine produced for each demo company (documents, tables, chunks,
  embeddings, search hits, organisation, processes, graph, pain points, metrics, evidence with their targets,
  opportunities, ROI, scores, roadmap, recommendations, insights, executive summary, report data). Exported by
  `backend/scripts/export_golden.py` (commit `9c3e50c`).
- `evals.json` — the results of the Python eval harness (`python -m evals`) on the same kit, timings aside.

The Python code was removed once the port matched (migration M6); it remains in the git history up to commit
`2f7b1da`. These files are fixed: when the engine's behaviour changes on purpose, update the golden file in the
same commit and explain the difference in the commit message.
