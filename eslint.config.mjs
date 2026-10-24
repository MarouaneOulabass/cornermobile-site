import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts", "backend/**", "demo-data/**", "var/**"] },
  ...nextVitals,
  ...nextTs,
];

export default config;
