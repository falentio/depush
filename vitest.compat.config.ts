import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/compat/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})
