import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The PDF renderer runs its own React reconciler: load it from node_modules rather than bundling it.
  serverExternalPackages: ["@react-pdf/renderer", "pdf-lib"],
  // Read from disk at runtime by the API function (PDF fonts).
  outputFileTracingIncludes: { "/api/[...path]": ["./server/report/fonts/**"] },
  async headers() {
    // Pages only: /api responses carry their own security headers (server/http.ts).
    return [
      {
        source: "/((?!api/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
