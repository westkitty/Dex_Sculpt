import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/realCharacterAcceptance.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000
  }
});
