/** Executive report (screen 9): live draft for consultants, frozen published version for clients. */
import { record } from "../../audit";
import {
  getOwned,
  type MissionContext,
  missionContext,
} from "../../auth/context";
import { db, sql, transaction } from "../../db";
import { ValidationStatus } from "../../domain/enums";
import { body, HttpError } from "../../http";
import {
  buildReport,
  createExport,
  type ExportRow,
  PdfUnavailable,
  publicationCheck,
  publish,
  unpublish,
} from "../../services/report";
import { getStorage } from "../../storage";
import type { Router } from "../router";
import { attachment } from "./documents";
import {
  EXPORT_OUT,
  ExportIn,
  pick,
  PublishIn,
  RECOMMENDATION_OUT,
} from "../schemas";

// The report is static HTML: no script, no external resource, only framed by the app itself.
const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";
const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
};

async function publishedExport(
  ctx: MissionContext,
  format: string,
): Promise<ExportRow | null> {
  return db.maybeOne<ExportRow>(sql`
    SELECT * FROM exports WHERE mission_id = ${ctx.missionId} AND published AND format = ${format} ORDER BY created_at DESC, id LIMIT 1`);
}

function filename(ctx: MissionContext, exp: ExportRow): string {
  const slug =
    ctx.organization.name
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "rapport";
  return `rapport-${slug}-v${exp.analysis_version}${exp.published ? "" : "-brouillon"}.${exp.format}`;
}

async function pdfSafe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PdfUnavailable)
      throw new HttpError(503, error.message);
    throw error;
  }
}

function html(page: string): Response {
  return new Response(page, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": REPORT_CSP,
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "no-store",
    },
  });
}

export function register(r: Router): void {
  /** Structured report data (live). Consultants only: clients read the published snapshot. */
  r.get("/missions/:missionId/report", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    return buildReport(ctx.mission);
  });

  r.get("/missions/:missionId/recommendations", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const rows = await db.query(sql`
      SELECT * FROM recommendations WHERE mission_id = ${ctx.missionId}
      ${ctx.isClient ? sql`AND validation_status <> ${ValidationStatus.rejete}` : sql.empty()} ORDER BY ordinal, created_at, id`);
    return rows.map((rec) => pick(rec, RECOMMENDATION_OUT));
  });

  r.get("/missions/:missionId/report/html", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    if (ctx.canWrite) {
      const { renderHtml } = await import("../../report/html");
      return html(renderHtml(await buildReport(ctx.mission)));
    }
    const exp = ctx.mission.published_at
      ? await publishedExport(ctx, "html")
      : null;
    if (!exp) throw new HttpError(404, "Le rapport n'est pas encore publié");
    return html((await getStorage().get(exp.storage_key)).toString("utf8"));
  });

  r.get("/missions/:missionId/publication", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    return publicationCheck(ctx.mission);
  });

  /** Spec §1.11: publication follows consultant review; unreviewed items need an explicit acknowledgement. */
  r.post("/missions/:missionId/publish", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    const input = await body(req, PublishIn);
    const check = await publicationCheck(ctx.mission);
    if (!check.analyzed)
      throw new HttpError(409, "Lancez l'analyse avant de publier");
    if (!check.ready && !input.acknowledge_unreviewed) {
      throw new HttpError(409, {
        message: "Des éléments ne sont pas encore revus",
        unreviewed: check.unreviewed,
        contested: check.contested,
      });
    }
    return pdfSafe(() =>
      transaction(async (tx) => {
        const { mission, exports } = await publish(
          tx,
          ctx.missionId,
          ctx.user.id,
        );
        await record(
          "report.publish",
          {
            userId: ctx.user.id,
            organizationId: ctx.orgId,
            entityType: "mission",
            entityId: ctx.missionId,
            details: {
              version: mission.analysis_version,
              count: Object.values(check.unreviewed).reduce((a, b) => a + b, 0),
            },
          },
          tx,
        );
        return {
          published_at: mission.published_at,
          exports: exports.map((e) => pick(e, EXPORT_OUT)),
        };
      }),
    );
  });

  r.post("/missions/:missionId/unpublish", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    ctx.requireWrite();
    await transaction(async (tx) => {
      await unpublish(tx, ctx.missionId);
      await record(
        "report.unpublish",
        {
          userId: ctx.user.id,
          organizationId: ctx.orgId,
          entityType: "mission",
          entityId: ctx.missionId,
        },
        tx,
      );
    });
    return { published_at: null, exports: [] };
  });

  /** Draft export (watermarked until publication). */
  r.post(
    "/missions/:missionId/exports",
    async (req, p) => {
      const ctx = await missionContext(req, p.missionId);
      ctx.requireWrite();
      const input = await body(req, ExportIn);
      if (ctx.mission.analysis_version === 0)
        throw new HttpError(409, "Lancez l'analyse avant d'exporter");
      return pdfSafe(() =>
        transaction(async (tx) => {
          const exp = await createExport(
            tx,
            ctx.mission,
            input.format,
            ctx.user.id,
            { published: false },
          );
          await record(
            "report.export",
            {
              userId: ctx.user.id,
              organizationId: ctx.orgId,
              entityType: "export",
              entityId: exp.id,
              details: {
                format: input.format,
                version: ctx.mission.analysis_version,
              },
            },
            tx,
          );
          return pick(exp, EXPORT_OUT);
        }),
      );
    },
    201,
  );

  r.get("/missions/:missionId/exports", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const rows = await db.query<ExportRow>(sql`
      SELECT * FROM exports WHERE mission_id = ${ctx.missionId} ${ctx.canWrite ? sql.empty() : sql`AND published`} ORDER BY created_at DESC, id`);
    return rows.map((e) => pick(e, EXPORT_OUT));
  });

  r.get("/missions/:missionId/exports/:exportId/download", async (req, p) => {
    const ctx = await missionContext(req, p.missionId);
    const exp = await getOwned<ExportRow>(ctx, "exports", p.exportId);
    if (!ctx.canWrite && !exp.published)
      throw new HttpError(404, "Élément introuvable");
    const data = await getStorage().get(exp.storage_key);
    await record("report.download", {
      userId: ctx.user.id,
      organizationId: ctx.orgId,
      entityType: "export",
      entityId: exp.id,
      details: { format: exp.format },
    });
    const headers: Record<string, string> = {
      "Content-Type": MEDIA_TYPES[exp.format],
      "Content-Disposition": attachment(filename(ctx, exp)),
    };
    if (exp.format === "html") headers["Content-Security-Policy"] = REPORT_CSP;
    return new Response(new Uint8Array(data), { headers });
  });
}
