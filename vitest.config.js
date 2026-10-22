/* =========================================================
   ICASH — Vitest Configuration
   ========================================================= */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['server/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'server/**/*.test.js', 'vitest.config.js']
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});