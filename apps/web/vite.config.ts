import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Built by `npm run build:wasm`; not committed.
      "@bastion/crypto-wasm": fileURLToPath(new URL("../../crates/crypto/pkg", import.meta.url)),
    },
  },
  // Tauri expects a fixed port and fails if it is taken.
  server: {
    port: 5173,
    strictPort: true,
    // The API worker from `npm run dev:api`.
    proxy: { "/api": { target: "http://localhost:8787", rewrite: (p) => p.replace(/^\/api/, ""), ws: true } },
  },
  build: { target: "es2022" },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
