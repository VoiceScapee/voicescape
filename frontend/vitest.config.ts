import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  // Vitest 4 no longer transforms .tsx implicitly: the React plugin provides
  // the automatic JSX runtime so components render in tests without an
  // explicit React import (tsconfig keeps jsx: preserve for Next.js).
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  // The agentic-web runtime tests (public/tests/agentified.test.mjs) run under
  // node --test with the real browser runtime, not vitest: they use node:test
  // and the runtime's own stub DOM. Keep vitest from collecting them (it
  // reports "No test suite found" for node:test files).
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "public/tests/**",
    ],
  },
});
