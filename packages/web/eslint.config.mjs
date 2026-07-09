import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react-hooks v7 (pulled in by eslint-config-next 16.2.9)
    // ships the React Compiler's static-analysis rules and enables them as
    // ERRORS in its recommended config. Those rules enforce React-Compiler
    // compatibility — but this app does NOT run the compiler (no
    // `experimental.reactCompiler` in next.config.ts, no
    // babel-plugin-react-compiler), so the patterns they flag (a setState in an
    // effect body, reading a ref during render, etc.) are not runtime bugs here.
    // Gating the build on compiler-readiness the codebase never opted into would
    // block CI on ~35 pre-existing intentional patterns. Downgrade them to
    // warnings so they stay visible (for an eventual compiler adoption) without
    // failing lint. Flip these back to "error" if/when the React Compiler is
    // enabled and the code is made compiler-clean.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/purity": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
