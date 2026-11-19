import { defineConfig } from "vitest/config";

export default defineConfig({
  // Argon2id runs in pure JS in tests, which is slow by design.
  test: { testTimeout: 30_000 },
});
