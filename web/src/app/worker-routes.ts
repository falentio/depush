import { WORKER_ROUTES } from './paths.ts'

/**
 * The wrangler.jsonc `assets.run_worker_first` list. It is exact: `/api` covers
 * the bare path, the globs cover everything below it, and the other prefixes
 * are API surfaces only below their root.
 */
export const RUN_WORKER_FIRST = [
  WORKER_ROUTES.api,
  `${WORKER_ROUTES.api}/*`,
  `${WORKER_ROUTES.apps}/*`,
  `${WORKER_ROUTES.app}/*`,
  WORKER_ROUTES.healthz,
] as const
