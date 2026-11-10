import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Several suites load real sherpa-onnx models (Stage 3) and run scrypt
    // hashing (Stage 1); letting every test file claim its own thread at full
    // CPU-count parallelism starves those out under contention — hook timeouts,
    // and on constrained hardware a worker segfault. A modest cap trades a
    // little wall-clock time for a suite that reliably passes via `npm test`.
    poolOptions: {
      threads: {
        maxThreads: 4,
        minThreads: 1,
      },
    },
    // Storage driver defaults to in-memory so the suite runs with no Postgres or
    // Redis; the Postgres driver is exercised by the infra-backed e2e run.
    env: {
      NODE_ENV: "test",
      STORAGE_DRIVER: "memory",
      AUTH_TOKEN_SECRET: "test-secret-not-used-anywhere-real",
    },
  },
});
