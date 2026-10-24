/** The /api router: every route module, registered in the order of the reference API. */
import "server-only";
import { Router } from "./router";
import * as analysis from "./routes/analysis";
import * as auth from "./routes/auth";
import * as documents from "./routes/documents";
import * as findings from "./routes/findings";
import * as missions from "./routes/missions";
import * as opportunities from "./routes/opportunities";
import * as orgs from "./routes/orgs";
import * as report from "./routes/report";
import * as roadmap from "./routes/roadmap";
import * as system from "./routes/system";

let router: Router | null = null;

export function apiRouter(): Router {
  if (!router) {
    router = new Router();
    router.get("/health", async () => ({ status: "ok" }));
    for (const routes of [system, auth, orgs, missions, documents, analysis, findings, opportunities, roadmap, report]) routes.register(router);
  }
  return router;
}
