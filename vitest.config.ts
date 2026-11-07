import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', '.sandcastle/agent-workflows/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
