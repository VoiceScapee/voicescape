import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  // Match the Next.js automatic JSX runtime so components render in tests
  // without an explicit React import.
  esbuild: {
    jsx: "automatic",
  },
});
