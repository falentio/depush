import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: 'test-better-auth-secret-value-0123456789',
          BETTER_AUTH_URL: 'http://depush.test',
          LOG_LEVEL: 'warning',
        },
      },
    }),
  ],
  test: {
    exclude: [...configDefaults.exclude, 'test/compat/**', 'test/client/**'],
    // better-auth hashes passwords with scrypt, which takes seconds on a cold
    // workerd isolate.
    testTimeout: 30_000,
  },
})
