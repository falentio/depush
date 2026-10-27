import { WORKER_PREFIXES } from './paths.ts'

const [api, apps, app, healthz] = WORKER_PREFIXES

export const WORKER_ROUTE_PREFIXES = WORKER_PREFIXES

/**
 * The wrangler.jsonc `assets.run_worker_first` list. It is exact: `/api` covers
 * the bare path, the globs cover everything below it, and the other prefixes
 * are API surfaces only below their root.
 */
export const RUN_WORKER_FIRST = [
  api,
  `${api}/*`,
  `${apps}/*`,
  `${app}/*`,
  healthz,
] as const
