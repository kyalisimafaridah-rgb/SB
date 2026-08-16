import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

// Same fix as server/_core/vite.ts, and for the same reason: this file gets
// bundled directly into dist/index.js (imported by server/_core/vite.ts,
// which server/_core/index.ts imports unconditionally at the top), and a
// bare __dirname doesn't exist in the ES module scope that bundle runs in —
// it crashes at module-load time, before any function in this file is even
// called.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client/src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  root: path.resolve(__dirname, "client"),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
