import { describe, expect, it } from 'vitest'
import indexSource from '../../index.html?raw'
import wranglerSource from '../../wrangler.jsonc?raw'
import { assertRouteNamespace, isWorkerPath, paths, WORKER_PREFIXES } from '@/app/paths'
import { RUN_WORKER_FIRST } from '@/app/worker-routes'
import { THEME_STORAGE_KEY } from '@/lib/theme'

const wrangler = JSON.parse(wranglerSource) as {
  assets: { run_worker_first: string[] }
}

describe('client paths', () => {
  it('names only the root and the console namespace', () => {
    for (const path of Object.values(paths)) {
      expect(path === '/' || path.startsWith('/console')).toBe(true)
    }
  })

  it('never names a Worker path', () => {
    for (const path of Object.values(paths)) {
      expect(isWorkerPath(path)).toBe(false)
    }
  })

  it.each(WORKER_PREFIXES)('rejects %s and everything below it', (prefix) => {
    expect(() => assertRouteNamespace([prefix])).toThrow(/Worker route/)
    expect(() => assertRouteNamespace([`${prefix}/anything`])).toThrow(/Worker route/)
  })

  it('accepts the console route table', () => {
    expect(() => assertRouteNamespace(Object.values(paths))).not.toThrow()
  })

  it('rejects a client path outside the namespace', () => {
    expect(() => assertRouteNamespace(['/elsewhere'])).toThrow(/outside the \/console namespace/)
  })

  it('keeps wrangler run_worker_first in sync', () => {
    expect(wrangler.assets.run_worker_first).toEqual([...RUN_WORKER_FIRST])
    expect(wrangler.assets.run_worker_first).toEqual([
      '/api',
      '/api/*',
      '/apps/*',
      '/app/*',
      '/healthz',
    ])
  })
})

describe('theme boot script', () => {
  it('uses the same storage key before paint', () => {
    expect(THEME_STORAGE_KEY).toBe('depush:theme')
    expect(indexSource).toContain(THEME_STORAGE_KEY)
  })
})
