/**
 * Clerk session handling for pages and /api when Clerk is configured; a pass-through otherwise (local demo
 * accounts). Route handlers enforce authentication and tenant isolation themselves.
 */
import { clerkMiddleware } from "@clerk/nextjs/server";
import { type NextFetchEvent, type NextRequest, NextResponse } from "next/server";

const clerk = process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ? clerkMiddleware() : null;

export default function proxy(req: NextRequest, event: NextFetchEvent) {
  return clerk ? clerk(req, event) : NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|webmanifest)).*)", "/(api|trpc)(.*)"],
};
