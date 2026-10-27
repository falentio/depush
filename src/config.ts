import * as v from 'valibot'

export type AppConfig = {
  appId: string
  key: string
  secret: string
  activityTimeout: number
  cacheTtlSeconds: number
}

const DEFAULT_ACTIVITY_TIMEOUT = 120
export const DEFAULT_CACHE_TTL_SECONDS = 1800
export const MAX_CACHE_TTL_SECONDS = 1800

const credentialsSchema = v.object({
  PUSHER_APP_ID: v.pipe(v.string(), v.minLength(1)),
  PUSHER_APP_KEY: v.pipe(v.string(), v.minLength(1)),
  PUSHER_APP_SECRET: v.pipe(v.string(), v.minLength(1)),
})

const activityTimeoutSchema = v.pipe(
  v.string(),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(1),
)

const cacheTtlSchema = v.pipe(
  v.string(),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(MAX_CACHE_TTL_SECONDS),
)

export function readConfig(env: {
  PUSHER_APP_ID: string
  PUSHER_APP_KEY: string
  PUSHER_APP_SECRET: string
  PUSHER_ACTIVITY_TIMEOUT?: string | undefined
  PUSHER_CACHE_TTL_SECONDS?: string | undefined
}): AppConfig {
  const credentials = v.parse(credentialsSchema, env)
  return {
    appId: credentials.PUSHER_APP_ID,
    key: credentials.PUSHER_APP_KEY,
    secret: credentials.PUSHER_APP_SECRET,
    activityTimeout: readActivityTimeout(env.PUSHER_ACTIVITY_TIMEOUT),
    cacheTtlSeconds: readCacheTtlSeconds(env.PUSHER_CACHE_TTL_SECONDS),
  }
}

function readActivityTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ACTIVITY_TIMEOUT
  const parsed = v.safeParse(activityTimeoutSchema, raw)
  return parsed.success ? parsed.output : DEFAULT_ACTIVITY_TIMEOUT
}

function readCacheTtlSeconds(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CACHE_TTL_SECONDS
  const parsed = v.safeParse(cacheTtlSchema, raw)
  return parsed.success ? parsed.output : DEFAULT_CACHE_TTL_SECONDS
}
