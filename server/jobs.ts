/**
 * Background jobs with persisted progress (spec §16: "traitement asynchrone avec progression").
 *
 * The job row is the source of truth; work runs after the HTTP response with Next.js `after()` (inside the same
 * Vercel function invocation, bounded by its maxDuration), or inline in tests and scripts.
 */
import { db, sql } from "./db";
import { JobStatus } from "./domain/enums";
import type { JobRow } from "./rows";

export class Progress {
  constructor(private job: JobRow) {}

  async update(done: number, total?: number | null, message?: string | null): Promise<void> {
    if (total !== undefined && total !== null) this.job.total = total;
    this.job.done = done;
    this.job.progress = this.job.total ? Math.round((1000 * done) / this.job.total) / 10 : 0;
    if (message) this.job.message = message;
    await db.exec(sql`
      UPDATE jobs SET total = ${this.job.total}, done = ${done}, progress = ${this.job.progress}, message = ${this.job.message}
      WHERE id = ${this.job.id}`);
  }
}

export type JobHandler = (job: JobRow, progress: Progress) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

async function loadHandlers(): Promise<void> {
  if (handlers.size) return;
  await import("./services/ingestion");
  await import("./services/pipeline");
}

export async function createJob(opts: {
  organizationId: string;
  missionId: string | null;
  kind: string;
  total?: number;
  payload?: Record<string, unknown>;
}): Promise<JobRow> {
  return db.one<JobRow>(sql`
    INSERT INTO jobs (organization_id, mission_id, kind, status, total, payload, message)
    VALUES (${opts.organizationId}, ${opts.missionId}, ${opts.kind}, ${JobStatus.queued}, ${opts.total ?? 0},
      ${sql.json(opts.payload ?? {})}, 'En file d''attente')
    RETURNING *`);
}

export async function runJob(jobId: string): Promise<void> {
  await loadHandlers();
  const job = await db.maybeOne<JobRow>(sql`
    UPDATE jobs SET status = ${JobStatus.running}, started_at = now(), message = 'En cours'
    WHERE id = ${jobId} RETURNING *`);
  if (!job) return;
  try {
    const handler = handlers.get(job.kind);
    if (!handler) throw new Error(`no handler for job kind ${job.kind}`);
    const result = (await handler(job, new Progress(job))) ?? {};
    await db.exec(sql`
      UPDATE jobs SET status = ${JobStatus.done}, progress = 100, finished_at = now(),
        message = ${(result as { message?: string }).message ?? "Terminé"},
        payload = (payload::jsonb || ${sql.json({ result })}::jsonb)::json
      WHERE id = ${job.id}`);
  } catch (error) {
    const e = error as Error;
    console.error(`[auditflow] job ${jobId} failed`, e);
    await db.exec(sql`
      UPDATE jobs SET status = ${JobStatus.error}, finished_at = now(), message = 'Échec',
        error = ${`${e.name}: ${e.message}`.slice(0, 2000)}
      WHERE id = ${job.id}`);
  }
}

/** Inline in tests/scripts (AUDITFLOW_JOBS=inline), after the response otherwise. */
export async function dispatch(jobId: string): Promise<void> {
  if (process.env.AUDITFLOW_JOBS === "inline") {
    await runJob(jobId);
    return;
  }
  const { after } = await import("next/server");
  after(() => runJob(jobId));
}
