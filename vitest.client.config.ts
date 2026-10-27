import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url).href),
    },
  },
  test: {
    environment: 'node',
    include: ['test/client/**/*.test.{ts,tsx}'],
  },
})
