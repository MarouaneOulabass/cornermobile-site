import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts", "demo-data/**", "var/**"] },
  ...nextVitals,
  ...nextTs,
  {
    // `_`-prefixed names drop a key in a destructuring: `const { id: _, ...rest } = row`.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
  // The report is a standalone HTML document rendered by our own JSX runtime, not a Next page.
  { files: ["server/report/**"], rules: { "@next/next/no-head-element": "off" } },
];

export default config;
