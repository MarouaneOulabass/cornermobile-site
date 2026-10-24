"use client";

import "@xyflow/react/dist/style.css";
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  type NodeMouseHandler,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type EdgeMouseHandler,
  useReactFlow,
} from "@xyflow/react";
import { EyeOff, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { EvidencePanel } from "@/components/evidence/EvidencePanel";
import { useMission } from "@/components/shell/MissionContext";
import { Button, Empty, ErrorBox, Loading, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { NODE_KINDS, RELATION_LABELS } from "@/lib/labels";
import type { Graph, GraphEdge, GraphNode } from "@/lib/types";

const COLUMN_WIDTH = 320;
const ROW_HEIGHT = 74;

export function layout(nodes: GraphNode[]): Record<string, { x: number; y: number }> {
  const rows: Record<number, number> = {};
  const order = Object.keys(NODE_KINDS);
  const sorted = [...nodes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label, "fr"));
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of sorted) {
    const col = NODE_KINDS[n.kind]?.column ?? 6;
    const row = rows[col] ?? 0;
    rows[col] = row + 1;
    pos[n.id] = n.x !== null && n.y !== null ? { x: n.x, y: n.y } : { x: col * COLUMN_WIDTH, y: row * ROW_HEIGHT };
  }
  return pos;
}

type Selection = { type: "node"; node: GraphNode } | { type: "edge"; edge: GraphEdge } | null;

export function BusinessGraph() {
  return (
    <ReactFlowProvider>
      <GraphCanvas />
    </ReactFlowProvider>
  );
}

function GraphCanvas() {
  const { mission, canWrite } = useMission();
  const flow = useReactFlow();
  const key = `/missions/${mission.id}/graph`;
  const { data, mutate, error } = useSWR<Graph>(key);
  const [kinds, setKinds] = useState<Set<string>>(new Set(Object.keys(NODE_KINDS)));
  const [selection, setSelection] = useState<Selection>(null);
  const [pending, setPending] = useState<Connection | null>(null);
  const [relation, setRelation] = useState("uses");
  const [newNode, setNewNode] = useState({ kind: "tool", label: "" });
  const [rename, setRename] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);

  const byId = useMemo(() => Object.fromEntries((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const focusId = selection?.type === "node" ? selection.node.id : null;
  const focusEdgeId = selection?.type === "edge" ? selection.edge.id : null;
  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [] as Node[], edges: [] as Edge[] };
    const visible = data.nodes.filter((n) => kinds.has(n.kind));
    const ids = new Set(visible.map((n) => n.id));
    const pos = layout(data.nodes);
    // Neighbourhood of the selected node: everything else is dimmed so the structure stays readable.
    const neighbours = new Set<string>();
    if (focusId) {
      neighbours.add(focusId);
      for (const e of data.edges) {
        if (e.source_id === focusId) neighbours.add(e.target_id);
        if (e.target_id === focusId) neighbours.add(e.source_id);
      }
    }
    const flowNodes: Node[] = visible.map((n) => {
      const k = NODE_KINDS[n.kind] ?? { color: "#374151", bg: "#f3f4f6", label: n.kind };
      return {
        id: n.id,
        position: pos[n.id],
        data: { label: n.label },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: k.bg,
          color: k.color,
          border: `1px solid ${k.color}33`,
          borderRadius: 10,
          fontSize: 12,
          fontWeight: 700,
          width: 210,
          padding: "6px 10px",
          outline: n.origin === "user" ? "2px dashed #b45309" : n.id === focusId ? `2px solid ${k.color}` : undefined,
          opacity: focusId && !neighbours.has(n.id) ? 0.25 : 1,
        },
      };
    });
    const flowEdges: Edge[] = data.edges
      .filter((e) => ids.has(e.source_id) && ids.has(e.target_id))
      .map((e) => {
        const highlight = e.relation === "generates_reentry" || e.relation === "duplicated_in";
        const focused = e.id === focusEdgeId || (!!focusId && (e.source_id === focusId || e.target_id === focusId));
        const dimmed = !!focusId && !focused;
        const showLabel = focused || (!focusId && highlight);
        const text = e.label ? `${RELATION_LABELS[e.relation] ?? e.relation} · ${e.label}` : RELATION_LABELS[e.relation] ?? e.relation;
        return {
          id: e.id,
          source: e.source_id,
          target: e.target_id,
          label: showLabel ? text : undefined,
          labelStyle: { fontSize: 10, fill: highlight ? "#b91c1c" : "#374151", fontWeight: 600 },
          labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
          style: {
            stroke: highlight ? "#ef4444" : e.origin === "user" ? "#b45309" : focused ? "#2563eb" : "#cbd5e1",
            strokeWidth: focused ? 2.2 : highlight ? 1.6 : 1,
            opacity: dimmed ? 0.12 : 1,
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          zIndex: focused ? 10 : 0,
        };
      });
    return { nodes: flowNodes, edges: flowEdges };
  }, [data, kinds, focusId, focusEdgeId]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.nodes.length) return <Empty title="Graphe vide">Lancez l&apos;analyse pour reconstruire la cartographie de l&apos;entreprise.</Empty>;

  const onNodeClick: NodeMouseHandler = (_, n) => {
    setSelection({ type: "node", node: byId[n.id] });
    setRename(byId[n.id].label);
    const around = new Set([n.id]);
    for (const e of data.edges) {
      if (e.source_id === n.id) around.add(e.target_id);
      if (e.target_id === n.id) around.add(e.source_id);
    }
    const pos = layout(data.nodes);
    const pts = [...around].map((id) => pos[id]).filter(Boolean);
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxX = Math.max(...pts.map((p) => p.x)) + 210;
    const maxY = Math.max(...pts.map((p) => p.y)) + 40;
    flow.fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, { padding: 0.2, duration: 400 });
  };
  const onEdgeClick: EdgeMouseHandler = (_, e) => {
    const edge = data.edges.find((x) => x.id === e.id);
    if (edge) setSelection({ type: "edge", edge });
  };

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      await mutate();
    } catch (err) {
      setActionError(err);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <div className="card p-0">
        <div className="flex flex-wrap gap-1.5 border-b border-line p-3">
          {Object.entries(NODE_KINDS).map(([k, v]) => (
            <label key={k} className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: v.bg, color: v.color, opacity: kinds.has(k) ? 1 : 0.4 }}>
              <input
                type="checkbox"
                className="sr-only"
                checked={kinds.has(k)}
                onChange={() => {
                  const next = new Set(kinds);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  setKinds(next);
                }}
              />
              {v.label} ({data.nodes.filter((n) => n.kind === k).length})
            </label>
          ))}
        </div>
        <div className="h-[720px]" data-testid="business-graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            nodesDraggable={canWrite}
            nodesConnectable={canWrite}
            onConnect={(c) => canWrite && setPending(c)}
            onNodeDragStop={(_, n) => canWrite && api.patch(`/missions/${mission.id}/graph/nodes/${n.id}`, { x: n.position.x, y: n.position.y })}
            onPaneClick={() => {
              setSelection(null);
              flow.fitView({ padding: 0.05, duration: 300 });
            }}
            fitView
            fitViewOptions={{ padding: 0.05 }}
            minZoom={0.15}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>

      <aside className="space-y-4">
        {actionError ? <ErrorBox error={actionError} /> : null}
        {pending && (
          <div className="card space-y-2">
            <div className="text-sm font-bold">Nouvelle relation</div>
            <div className="text-xs text-muted">
              {byId[pending.source!]?.label} → {byId[pending.target!]?.label}
            </div>
            <select className="input" value={relation} onChange={(e) => setRelation(e.target.value)}>
              {Object.entries(RELATION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => act(async () => { await api.post(`/missions/${mission.id}/graph/edges`, { source_id: pending.source, target_id: pending.target, relation }); setPending(null); })}>
                Créer
              </Button>
              <Button size="sm" onClick={() => setPending(null)}>
                Annuler
              </Button>
            </div>
          </div>
        )}
        {selection?.type === "edge" && (
          <div className="card space-y-3">
            <div className="text-sm">
              <b>{byId[selection.edge.source_id]?.label}</b> <span className="text-muted">{RELATION_LABELS[selection.edge.relation]}</span> <b>{byId[selection.edge.target_id]?.label}</b>
            </div>
            {selection.edge.label && <Pill tone="info">{selection.edge.label}</Pill>}
            {selection.edge.origin === "user" ? (
              <div className="text-xs text-check">Relation ajoutée par un consultant</div>
            ) : (
              <EvidencePanel missionId={mission.id} targetType="graph_edge" targetId={selection.edge.id} emptyLabel="Relation déduite de la structure (pas de preuve directe)." />
            )}
            {canWrite && (
              <Button size="sm" variant="danger" onClick={() => act(async () => { await api.del(`/missions/${mission.id}/graph/edges/${selection.edge.id}`); setSelection(null); })}>
                <EyeOff size={14} /> Retirer la relation
              </Button>
            )}
          </div>
        )}
        {selection?.type === "node" && (
          <div className="card space-y-3">
            <div className="flex items-center justify-between gap-2">
              <b className="text-sm">{selection.node.label}</b>
              <Pill>{NODE_KINDS[selection.node.kind]?.label ?? selection.node.kind}</Pill>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {Object.entries(selection.node.properties)
                .filter(([k, v]) => v !== null && v !== "" && !["hidden", "label_edited"].includes(k) && typeof v !== "object")
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{k}</dt>
                    <dd>{String(v)}</dd>
                  </div>
                ))}
            </dl>
            <div className="text-xs text-muted">
              {data.edges.filter((e) => e.source_id === selection.node.id || e.target_id === selection.node.id).length} relation(s)
            </div>
            {canWrite && (
              <div className="space-y-2 border-t border-line pt-3">
                <div className="flex gap-2">
                  <input className="input" value={rename} onChange={(e) => setRename(e.target.value)} aria-label="Renommer" />
                  <Button size="sm" onClick={() => act(() => api.patch(`/missions/${mission.id}/graph/nodes/${selection.node.id}`, { label: rename }))}>
                    Renommer
                  </Button>
                </div>
                <Button size="sm" variant="danger" onClick={() => act(async () => { await api.del(`/missions/${mission.id}/graph/nodes/${selection.node.id}`); setSelection(null); })}>
                  <EyeOff size={14} /> {selection.node.origin === "user" ? "Supprimer" : "Masquer"}
                </Button>
              </div>
            )}
          </div>
        )}
        {!selection && !pending && (
          <div className="card text-xs text-muted">Cliquez sur une relation pour voir ses preuves, ou sur un élément pour le détailler.{canWrite && " Reliez deux éléments en tirant depuis leurs poignées pour créer une relation."}</div>
        )}
        {canWrite && (
          <form
            className="card space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newNode.label.trim()) return;
              act(async () => {
                await api.post(`/missions/${mission.id}/graph/nodes`, newNode);
                setNewNode({ ...newNode, label: "" });
              });
            }}
          >
            <div className="text-sm font-bold">Ajouter un élément</div>
            <select className="input" value={newNode.kind} onChange={(e) => setNewNode({ ...newNode, kind: e.target.value })}>
              {Object.entries(NODE_KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
            <input className="input" placeholder="Libellé" value={newNode.label} onChange={(e) => setNewNode({ ...newNode, label: e.target.value })} />
            <Button size="sm" type="submit">
              <Plus size={14} /> Ajouter
            </Button>
          </form>
        )}
      </aside>
    </div>
  );
}
