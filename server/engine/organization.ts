/** Persist the reconstructed organisation: departments, tools, people, data sources, processes. */
import { randomUUID } from "node:crypto";
import { sql } from "../db";
import { TargetType, ValidationStatus } from "../domain/enums";
import type { AnalysisContext, Evidence } from "./context";
import type { Extraction } from "./extract";
import { citeSource } from "./graph";
import { TOOLS } from "./semantics";

const TOOL_CATEGORY = new Map(TOOLS.map(([name, cat]) => [name, cat]));

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function persistOrganization(ctx: AnalysisContext, ex: Extraction): Promise<Record<string, number>> {
  const tx = ctx.db;
  const mid = ctx.mission.id;
  const oid = ctx.orgId;
  for (const table of ["people", "departments", "data_sources", "tools"]) await tx.exec(sql`DELETE FROM ${sql.raw(table)} WHERE mission_id = ${mid}`);

  const toolNames = new Set<string>([...ex.org.tools.keys(), ...ex.org.declaredSystems.map(([t]) => t), ...ex.processes.flatMap((p) => [...p.tools.keys()])]);
  const tools = new Map<string, string>();
  const toolRows = sortedStrings(toolNames).map((name) => {
    const id = randomUUID();
    tools.set(name, id);
    return { id, organization_id: oid, mission_id: mid, name, category: TOOL_CATEGORY.get(name) ?? "autre", users_count: ex.org.tools.count(name) };
  });
  await tx.insertMany("tools", { id: "uuid", organization_id: "uuid", mission_id: "uuid", name: "text", category: "text", users_count: "integer" }, toolRows, "id");
  const departments = new Map<string, string>();
  const deptRows = [...ex.org.departments.values()].map((d) => {
    const id = randomUUID();
    departments.set(d.name, id);
    return { id, organization_id: oid, mission_id: mid, name: d.name, headcount: d.headcount, manager_external_id: d.manager };
  });
  await tx.insertMany("departments", { id: "uuid", organization_id: "uuid", mission_id: "uuid", name: "text", headcount: "integer", manager_external_id: "text" }, deptRows, "id");
  await tx.insertMany(
    "people",
    { organization_id: "uuid", mission_id: "uuid", external_id: "text", name: "text", role: "text", seniority_years: "double precision", department_id: "uuid", primary_tool_id: "uuid" },
    ex.org.people.map((p) => ({
      organization_id: oid,
      mission_id: mid,
      external_id: p.external_id,
      name: p.name,
      role: p.role,
      seniority_years: p.seniority,
      department_id: departments.get(p.department) ?? null,
      primary_tool_id: p.tool ? (tools.get(p.tool) ?? null) : null,
    })),
    "id",
  );
  await tx.insertMany(
    "data_sources",
    { organization_id: "uuid", mission_id: "uuid", name: "text", kind: "text", notes: "text" },
    ctx.datasets.map((ds) => {
      const systems = sortedStrings(new Set(ex.processes.filter((p) => p.dataset === ds).flatMap((p) => [...p.tools].filter(([, s]) => s.dataset === ds).map(([t]) => t))));
      return {
        organization_id: oid,
        mission_id: mid,
        name: ds.label,
        kind: ds.kind ?? "table",
        notes: `${ds.document.path} — ${ds.n} lignes${systems.length ? ` — saisi dans : ${systems.join(", ")}` : ""}`,
      };
    }),
    "id",
  );
  return { departments: departments.size, tools: tools.size, people: ex.org.people.length };
}

interface ProcessRow {
  id: string;
  name: string;
  validation_status: string;
  edited_fields: string[];
}

/** Upsert processes by name; a process the consultant reviewed keeps its edited fields. Returns name → id. */
export async function persistProcesses(ctx: AnalysisContext, ex: Extraction): Promise<Map<string, string>> {
  const tx = ctx.db;
  const mid = ctx.mission.id;
  const oid = ctx.orgId;
  const existing = new Map((await tx.query<ProcessRow>(sql`SELECT id, name, validation_status, edited_fields FROM processes WHERE mission_id = ${mid}`)).map((p) => [p.name, p]));
  const result = new Map<string, string>();
  for (const info of ex.processes) {
    const proc = existing.get(info.name);
    existing.delete(info.name);
    const generated: Record<string, unknown> = {
      description: info.description,
      owner_department: info.ownerDepartment,
      tools: sortedStrings(info.tools.keys()),
      cycle_time_minutes: info.cycleTimeMinutes,
    };
    const ownerDefined = info.origin !== "procedure" ? info.ownerDefined && info.ownerDepartment !== null : info.ownerDefined;
    const sourceDocument = info.document ? info.document.document.id : info.dataset ? info.dataset.document.id : null;
    let id: string;
    if (!proc) {
      id = randomUUID();
      await tx.exec(sql`
        INSERT INTO processes (id, organization_id, mission_id, name, description, owner_department, tools, cycle_time_minutes,
          generated, owner_defined, inputs, outputs, confidence, source_document_id)
        VALUES (${id}, ${oid}, ${mid}, ${info.name}, ${info.description}, ${info.ownerDepartment}, ${sql.json(generated.tools)},
          ${info.cycleTimeMinutes}, ${sql.json(generated)}, ${ownerDefined}, ${sql.json(info.inputs)}, ${sql.json(info.outputs)},
          ${info.confidence}, ${sourceDocument})`);
    } else {
      id = proc.id;
      const reviewed = proc.validation_status !== ValidationStatus.a_verifier || (proc.edited_fields ?? []).length > 0;
      const keep = (field: string) => reviewed && (proc.edited_fields ?? []).includes(field);
      await tx.exec(sql`
        UPDATE processes SET
          description = ${keep("description") ? sql`description` : sql`${info.description}`},
          owner_department = ${keep("owner_department") ? sql`owner_department` : sql`${info.ownerDepartment}`},
          tools = ${keep("tools") ? sql`tools` : sql`${sql.json(generated.tools)}`},
          cycle_time_minutes = ${keep("cycle_time_minutes") ? sql`cycle_time_minutes` : sql`${info.cycleTimeMinutes}`},
          generated = ${sql.json(generated)}, owner_defined = ${ownerDefined}, inputs = ${sql.json(info.inputs)},
          outputs = ${sql.json(info.outputs)}, confidence = ${info.confidence}, source_document_id = ${sourceDocument}
        WHERE id = ${id}`);
    }
    await tx.exec(sql`DELETE FROM process_steps WHERE process_id = ${id}`);
    await tx.insertMany(
      "process_steps",
      { organization_id: "uuid", process_id: "uuid", ordinal: "integer", label: "text", tool: "text", is_manual: "boolean", is_reentry: "boolean", requires_validation: "boolean", line: "integer" },
      info.steps.map((s) => ({
        organization_id: oid,
        process_id: id,
        ordinal: s.ordinal,
        label: s.label,
        tool: s.tools.join(", ") || null,
        is_manual: s.isManual,
        is_reentry: s.isReentry,
        requires_validation: s.requiresValidation,
        line: s.line,
      })),
      "id",
    );
    const evidence = [...info.tools.values()].map((src) => citeSource(ctx, src, "process")).filter((ev): ev is Evidence => ev !== null);
    if (info.cycleTimeSource) {
      const ev = citeSource(ctx, info.cycleTimeSource, "process");
      if (ev) evidence.push(ev);
    }
    if (evidence.length) ctx.link(evidence, TargetType.process, id);
    result.set(info.name, id);
  }
  const stale = [...existing.values()].filter((p) => p.validation_status === ValidationStatus.a_verifier && !(p.edited_fields ?? []).length).map((p) => p.id);
  if (stale.length) await tx.exec(sql`DELETE FROM processes WHERE id = ANY(${stale}::uuid[])`);
  return result;
}
