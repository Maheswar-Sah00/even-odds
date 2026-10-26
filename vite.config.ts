/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const sharedDir = fileURLToPath(new URL('./shared', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Only VITE_* variables reach the bundle. Server values live in .env.server,
  // which Vite never reads (its env loader only reads .env and .env.[mode][.local]).
  envPrefix: 'VITE_',
  resolve: {
    alias: { '@shared': sharedDir },
  },
  // Inline (empty) PostCSS config stops Vite searching parent directories for a
  // postcss.config.* that belongs to another project.
  css: { postcss: {} },
  build: {
    sourcemap: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['tests/unit/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          // Real network calls against Appwrite Cloud: run files serially, allow time.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          // Task 14 load/race suite (hundreds of simultaneous real transactions). Kept out of
          // "integration" so the everyday suite stays fast; see docs/TEST-REPORT.md.
          name: 'stress',
          include: ['tests/stress/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
          testTimeout: 900_000,
          hookTimeout: 900_000,
        },
      },
    ],
  },
});
