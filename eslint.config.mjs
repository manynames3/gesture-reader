import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["electron/**/*.cjs", "forge.config.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".wrangler/**",
    "out/**",
    "build/**",
    "dist/**",
    "electron-dist/**",
    "public/vendor/**",
    "outputs/**",
    "test-results/**",
    "playwright-report/**",
    "tmp/**",
    "work/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
