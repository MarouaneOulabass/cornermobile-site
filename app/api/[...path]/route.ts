/** Every /api request goes through the API router (server/api). */
import type { NextRequest } from "next/server";
import { apiRouter } from "@/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Imports and analyses run after the response (next/server `after`), inside this invocation.
export const maxDuration = 300;

const handler = (req: NextRequest) => apiRouter().dispatch(req);

export { handler as DELETE, handler as GET, handler as HEAD, handler as PATCH, handler as POST, handler as PUT };
