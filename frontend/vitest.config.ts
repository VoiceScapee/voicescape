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
});
