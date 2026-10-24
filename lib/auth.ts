/** Clerk is used whenever its publishable key is configured (inlined at build time). */
export const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
