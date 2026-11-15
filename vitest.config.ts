import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Node by default. Export/reimport tests that need DOM file APIs opt in with
    // `// @vitest-environment jsdom` at the top of the file.
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
