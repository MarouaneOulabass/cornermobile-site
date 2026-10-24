/** Analysis run, business graph, processes, evidence, review and comments (shared by every finding type). */
import { randomUUID } from "node:crypto";
import { record } from "../../audit";
import { getOwned, type MissionContext, missionContext } from "../../auth/context";
import { db, sql, transaction, type Db } from "../../db";
import { Criticality, EvidenceKind, JobKind, JobStatus, TargetType, ValidationStatus } from "../../domain/enums";
import { body, HttpError, noContent } from "../../http";
import { dispatch } from "../../jobs";
import { sortedBy } from "../../lib/py";
import { recomputeMission } from "../../services/businessCase";
import type { DocumentRow } from "../../services/ingestion";
import { createAnalysisJob } from "../../services/pipeline";
import { addComment, applyReview, COMMENTABLE, history, loadTarget } from "../../services/review";
import type { Router } from "../router";
import {
  COMMENT_OUT,
  CommentIn,
  EVIDENCE_WITH_DOC,
  EvidenceIn,
  GRAPH_EDGE_OUT,
  GRAPH_NODE_OUT,
  GraphEdgeIn,
  GraphEdgePatch,
  GraphNodeIn,
  GraphNodePatch,
  pick,
  PROCESS_OUT,
  PROCESS_STEP_OUT,
  ReviewIn,
  VALIDATION_OUT,
} from "../schemas";

type Row = Record<string, unknown> & { id: string; organization_id: string };

async function linkCounts(missionId: string, targetType: string, tx: Db = db): Promise<Map<string, number>> {
  const rows = await tx.query<{ target_id: string; n: number }>(sql`
    SELECT target_id, count(*)::int AS n FROM evidence_links WHERE mission_id = ${missionId} AND target_type = ${targetType} GROUP BY target_id`);
  return new Map(rows.map((r) => [r.target_id, r.n]));
}

async function processCounters(ctx: MissionContext) {
  const pains = new Map<string, number>();
  const critical = new Map<string, number>();
  for (const row of await db.query<{ process_id: string; criticality: string }>(sql`
    SELECT process_id, criticality FROM pain_points
    WHERE mission_id = ${ctx.missionId} AND process_id IS NOT NULL AND validation_status <> ${ValidationStatus.rejete}`)) {
    pains.set(row.process_id, (pains.get(row.process_id) ?? 0) + 1);
    if (row.criticality === Criticality.critique || row.criticality === Criticality.elevee) critical.set(row.process_id, (critical.get(row.process_id) ?? 0) + 1);
  }
  return { pains, critical, evidence: await linkCounts(ctx.missionId, TargetType.process) };
}

async function processOut(processes: Row[], counters: Awaited<ReturnType<typeof processCounters>>) {
  const ids = processes.map((p) => p.id);
  const steps = ids.length
    ? await db.query<Row & { process_id: string }>(sql`SELECT * FROM process_steps WHERE process_id = ANY(${ids}::uuid[]) ORDER BY ordinal, line, id`)
    : [];
  return processes.map((p): Record<string, unknown> => ({
    ...pick(p, PROCESS_OUT),
    steps: steps.filter((s) => s.process_id === p.id).map((s) => pick(s, PROCESS_STEP_OUT)),
    pain_points: counters.pains.get(p.id) ?? 0,
    pain_points_critical: counters.critical.get(p.id) ?? 0,
    evidence_count: counters.evidence.get(p.id) ?? 0,
  }));
}

async function nextOrdinal(tx: Db, table: string, missionId: string): Promise<number> {
  return (await tx.one<{ n: number }>(sql`SELECT coalesce(max(ordinal) + 1, 0)::int AS n FROM ${sql.raw(table)} WHERE mission_id = ${missionId}`)).n;
}

export function register(r: Router): void {
  r.post(
    "/missions/:missionId/analyze",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const running = await db.maybeOne<{ id: string }>(sql`
        SELECT id FROM jobs WHERE mission_id = ${ctx.missionId} AND kind = ${JobKind.analyze} AND status IN (${JobStatus.queued}, ${JobStatus.running})
        ORDER BY created_at LIMIT 1`);
      if (running) return { job_id: running.id };
      const job = await createAnalysisJob(ctx.mission);
      await record("analysis.start", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "mission", entityId: ctx.missionId });
      await dispatch(job.id);
      return { job_id: job.id };
    },
    202,
  );

  // --- Business graph ---------------------------------------------------------------------------------------

  r.get("/missions/:missionId/graph", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const includeHidden = ["1", "true"].includes((req.nextUrl.searchParams.get("include_hidden") ?? "").toLowerCase());
    let nodes = await db.query<Row & { properties: Record<string, unknown> }>(sql`SELECT * FROM graph_nodes WHERE mission_id = ${ctx.missionId} ORDER BY ordinal, created_at, id`);
    let edges = await db.query<Row & { properties: Record<string, unknown>; source_id: string; target_id: string }>(sql`
      SELECT * FROM graph_edges WHERE mission_id = ${ctx.missionId} ORDER BY ordinal, created_at, id`);
    const counts = await linkCounts(ctx.missionId, TargetType.graph_edge);
    if (!includeHidden) {
      nodes = nodes.filter((n) => !n.properties?.hidden);
      const visible = new Set(nodes.map((n) => n.id));
      edges = edges.filter((e) => !e.properties?.hidden && visible.has(e.source_id) && visible.has(e.target_id));
    }
    return {
      nodes: nodes.map((n) => pick(n, GRAPH_NODE_OUT)),
      edges: edges.map((e) => ({ ...pick(e, GRAPH_EDGE_OUT), evidence_count: counts.get(e.id) ?? 0 })),
    };
  });

  r.post(
    "/missions/:missionId/graph/nodes",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const input = await body(req, GraphNodeIn);
      return transaction(async (tx) => {
        const node = await tx.one<Row>(sql`
          INSERT INTO graph_nodes (organization_id, mission_id, kind, key, label, properties, origin, x, y, ordinal)
          VALUES (${ctx.orgId}, ${ctx.missionId}, ${input.kind}, ${`user:${randomUUID().replaceAll("-", "").slice(0, 12)}`}, ${input.label},
            ${sql.json(input.note ? { note: input.note } : {})}, 'user', ${input.x ?? null}, ${input.y ?? null}, ${await nextOrdinal(tx, "graph_nodes", ctx.missionId)})
          RETURNING *`);
        await record("graph.node.create", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "graph_node" }, tx);
        return pick(node, GRAPH_NODE_OUT);
      });
    },
    201,
  );

  r.patch("/missions/:missionId/graph/nodes/:nodeId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    const node = await getOwned<Row & { label: string; properties: Record<string, unknown>; x: number | null; y: number | null }>(ctx, "graph_nodes", p.nodeId);
    const changes = (await body(req, GraphNodePatch)) as Record<string, unknown>;
    const props = { ...(node.properties ?? {}) };
    let { label, x, y } = node;
    if ("label" in changes && changes.label !== node.label) {
      label = changes.label as string;
      props.label_edited = true;
    }
    if ("note" in changes) props.note = changes.note;
    if ("hidden" in changes) props.hidden = Boolean(changes.hidden);
    if ("x" in changes) x = changes.x as number | null;
    if ("y" in changes) y = changes.y as number | null;
    return transaction(async (tx) => {
      const updated = await tx.one<Row>(sql`
        UPDATE graph_nodes SET label = ${label}, properties = ${sql.json(props)}, x = ${x}, y = ${y} WHERE id = ${node.id} RETURNING *`);
      if (Object.keys(changes).some((k) => k !== "x" && k !== "y")) {
        await record(
          "graph.node.update",
          { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "graph_node", entityId: node.id, details: { fields: Object.keys(changes).sort() } },
          tx,
        );
      }
      return pick(updated, GRAPH_NODE_OUT);
    });
  });

  /** User nodes are deleted; engine nodes are hidden so a re-analysis does not bring them back. */
  r.delete(
    "/missions/:missionId/graph/nodes/:nodeId",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const node = await getOwned<Row & { origin: string; properties: Record<string, unknown> }>(ctx, "graph_nodes", p.nodeId);
      await transaction(async (tx) => {
        if (node.origin === "user") await tx.exec(sql`DELETE FROM graph_nodes WHERE id = ${node.id}`);
        else await tx.exec(sql`UPDATE graph_nodes SET properties = ${sql.json({ ...(node.properties ?? {}), hidden: true })} WHERE id = ${node.id}`);
        await record("graph.node.delete", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "graph_node", entityId: node.id }, tx);
      });
      return noContent();
    },
    204,
  );

  r.post(
    "/missions/:missionId/graph/edges",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const input = await body(req, GraphEdgeIn);
      await getOwned(ctx, "graph_nodes", input.source_id);
      await getOwned(ctx, "graph_nodes", input.target_id);
      return transaction(async (tx) => {
        const edge = await tx.one<Row>(sql`
          INSERT INTO graph_edges (organization_id, mission_id, source_id, target_id, relation, label, origin, ordinal)
          VALUES (${ctx.orgId}, ${ctx.missionId}, ${input.source_id}, ${input.target_id}, ${input.relation}, ${input.label ?? null}, 'user',
            ${await nextOrdinal(tx, "graph_edges", ctx.missionId)})
          RETURNING *`);
        await record("graph.edge.create", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "graph_edge" }, tx);
        return { ...pick(edge, GRAPH_EDGE_OUT), evidence_count: 0 };
      });
    },
    201,
  );

  r.patch("/missions/:missionId/graph/edges/:edgeId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    const edge = await getOwned<Row & { label: string | null; relation: string; properties: Record<string, unknown> }>(ctx, "graph_edges", p.edgeId);
    const changes = (await body(req, GraphEdgePatch)) as Record<string, unknown>;
    let { label, relation, properties } = edge;
    if ("label" in changes) label = (changes.label as string | null) ?? null;
    if ("relation" in changes && changes.relation) relation = changes.relation as string;
    if ("hidden" in changes) properties = { ...(properties ?? {}), hidden: Boolean(changes.hidden) };
    return transaction(async (tx) => {
      const updated = await tx.one<Row>(sql`
        UPDATE graph_edges SET label = ${label}, relation = ${relation}, properties = ${sql.json(properties ?? {})} WHERE id = ${edge.id} RETURNING *`);
      await record(
        "graph.edge.update",
        { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "graph_edge", entityId: edge.id, details: { fields: Object.keys(changes).sort() } },
        tx,
      );
      return { ...pick(updated, GRAPH_EDGE_OUT), evidence_count: (await linkCounts(ctx.missionId, TargetType.graph_edge, tx)).get(edge.id) ?? 0 };
    });
  });

  r.delete(
    "/missions/:missionId/graph/edges/:edgeId",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const edge = await getOwned<Row & { origin: string; properties: Record<string, unknown> }>(ctx, "graph_edges", p.edgeId);
      await transaction(async (tx) => {
        if (edge.origin === "user") await tx.exec(sql`DELETE FROM graph_edges WHERE id = ${edge.id}`);
        else await tx.exec(sql`UPDATE graph_edges SET properties = ${sql.json({ ...(edge.properties ?? {}), hidden: true })} WHERE id = ${edge.id}`);
        await record("graph.edge.delete", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: "graph_edge", entityId: edge.id }, tx);
      });
      return noContent();
    },
    204,
  );

  // --- Processes --------------------------------------------------------------------------------------------

  r.get("/missions/:missionId/processes", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const procs = (await db.query<Row & { validation_status: string }>(sql`SELECT * FROM processes WHERE mission_id = ${ctx.missionId} ORDER BY created_at, id`)).filter(
      (pr) => !(ctx.isClient && pr.validation_status === ValidationStatus.rejete),
    );
    const out = await processOut(procs, await processCounters(ctx));
    return sortedBy(out, (pr: Record<string, unknown>) => [-(pr.pain_points_critical as number), -(pr.pain_points as number), pr.source_document_id === null, pr.name as string]);
  });

  r.get("/missions/:missionId/processes/:processId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const proc = await getOwned<Row>(ctx, "processes", p.processId);
    return (await processOut([proc], await processCounters(ctx)))[0];
  });

  // --- Evidence, review and comments ------------------------------------------------------------------------

  r.get("/missions/:missionId/evidence", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const targetType = req.nextUrl.searchParams.get("target_type");
    const targetId = req.nextUrl.searchParams.get("target_id");
    if (!targetType || !targetId) throw new HttpError(422, [{ loc: ["query", targetType ? "target_id" : "target_type"], msg: "Field required", type: "missing" }]);
    const rows = await db.query<Row>(sql`
      SELECT e.*, d.filename, d.path, d.category FROM evidence_links l
      JOIN evidence e ON e.id = l.evidence_id LEFT JOIN documents d ON d.id = e.document_id
      WHERE l.mission_id = ${ctx.missionId} AND l.organization_id = ${ctx.orgId} AND l.target_type = ${targetType} AND l.target_id::text = ${targetId}
      ORDER BY e.relevance DESC, e.created_at, e.ordinal, l.ordinal`);
    return rows.map((e) => pick(e, EVIDENCE_WITH_DOC));
  });

  r.post(
    "/missions/:missionId/evidence",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const input = await body(req, EvidenceIn);
      if (!COMMENTABLE.has(input.target_type)) throw new HttpError(422, "Cible inconnue");
      return transaction(async (tx) => {
        if (input.target_type === TargetType.graph_edge) await getOwned(ctx, "graph_edges", input.target_id, tx);
        else if (input.target_type === TargetType.graph_node) await getOwned(ctx, "graph_nodes", input.target_id, tx);
        else if (input.target_type === TargetType.metric) await getOwned(ctx, "metrics", input.target_id, tx);
        else await loadTarget(tx, ctx, input.target_type, input.target_id);
        const doc = await getOwned<DocumentRow>(ctx, "documents", input.document_id, tx);
        let fields: { kind: string; locator: Record<string, unknown>; excerpt: string };
        if (input.table_id) {
          const table = await getOwned<Row & { name: string; row_count: number; columns: string[] }>(ctx, "data_tables", input.table_id, tx);
          const rows = (input.rows ?? []).filter((n) => n >= 1 && n <= table.row_count);
          fields = {
            kind: EvidenceKind.rows,
            locator: { table_id: table.id, table: table.name, rows, row_count: rows.length, columns: table.columns },
            excerpt: "",
          };
        } else {
          const lines = (doc.text ?? "").split("\n");
          const [rawLo, rawHi] = input.lines ?? [1, Math.min(3, lines.length)];
          const lo = Math.max(1, rawLo);
          const hi = Math.min(lines.length, Math.max(lo, rawHi));
          fields = { kind: EvidenceKind.excerpt, locator: { lines: [lo, hi] }, excerpt: lines.slice(lo - 1, hi).join("\n") };
        }
        const ev = await tx.one<Row>(sql`
          INSERT INTO evidence (organization_id, mission_id, document_id, kind, locator, excerpt, summary, origin, relevance)
          VALUES (${ctx.orgId}, ${ctx.missionId}, ${doc.id}, ${fields.kind}, ${sql.json(fields.locator)}, ${fields.excerpt}, ${input.summary}, 'user', 0.8)
          RETURNING *`);
        await tx.exec(sql`
          INSERT INTO evidence_links (organization_id, mission_id, evidence_id, target_type, target_id)
          VALUES (${ctx.orgId}, ${ctx.missionId}, ${ev.id}, ${input.target_type}, ${input.target_id})`);
        await record("evidence.add", { userId: ctx.user.id, organizationId: ctx.orgId, entityType: input.target_type, entityId: input.target_id }, tx);
        return pick({ ...ev, filename: doc.filename, path: doc.path, category: doc.category }, EVIDENCE_WITH_DOC);
      });
    },
    201,
  );

  r.post("/missions/:missionId/review/:targetType/:targetId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    const input = await body(req, ReviewIn);
    return transaction(async (tx) => {
      const validation = await applyReview(tx, ctx, p.targetType, p.targetId, input.status, input.comment, input.changes);
      // A changed hypothesis, category, effort or criticality moves ROI, scores and P1/P2/P3 labels.
      if (p.targetType === TargetType.assumption || p.targetType === TargetType.opportunity || p.targetType === TargetType.pain_point) {
        await recomputeMission(tx, ctx.missionId);
      }
      return pick(validation, VALIDATION_OUT);
    });
  });

  r.get("/missions/:missionId/review/:targetType/:targetId", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const item = await loadTarget(db, ctx, p.targetType, p.targetId);
    return (await history(db, ctx, p.targetType, item.id)).map((v) => pick(v, VALIDATION_OUT));
  });

  r.get("/missions/:missionId/comments", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const targetType = req.nextUrl.searchParams.get("target_type");
    const targetId = req.nextUrl.searchParams.get("target_id");
    if (!targetType || !targetId) throw new HttpError(422, [{ loc: ["query", targetType ? "target_id" : "target_type"], msg: "Field required", type: "missing" }]);
    const rows = await db.query<Row>(sql`
      SELECT * FROM comments WHERE mission_id = ${ctx.missionId} AND target_type = ${targetType} AND target_id::text = ${targetId} ORDER BY created_at, id`);
    return rows.map((c) => pick(c, COMMENT_OUT));
  });

  r.post(
    "/missions/:missionId/comments",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      const input = await body(req, CommentIn);
      return transaction(async (tx) => pick(await addComment(tx, ctx, input.target_type, input.target_id, input.body, input.kind), COMMENT_OUT));
    },
    201,
  );
}
