import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and fails if it is taken.
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
