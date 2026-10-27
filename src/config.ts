import * as v from 'valibot'

export type AppConfig = {
  appId: string
  key: string
  secret: string
  activityTimeout: number
  cacheTtlSeconds: number
}

export type PusherSettings = Pick<AppConfig, 'activityTimeout' | 'cacheTtlSeconds'>

type EnvInput = {
  PUSHER_ACTIVITY_TIMEOUT?: string | undefined
  PUSHER_CACHE_TTL_SECONDS?: string | undefined
}

const DEFAULT_ACTIVITY_TIMEOUT = 120
export const DEFAULT_CACHE_TTL_SECONDS = 1800
export const MAX_CACHE_TTL_SECONDS = 1800

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

export function readSettings(env: EnvInput): PusherSettings {
  return {
    activityTimeout: readActivityTimeout(env.PUSHER_ACTIVITY_TIMEOUT),
    cacheTtlSeconds: readCacheTtlSeconds(env.PUSHER_CACHE_TTL_SECONDS),
  }
}

export function appConfig(
  app: { id: string; key: string; secret: string },
  settings: PusherSettings,
): AppConfig {
  return {
    appId: app.id,
    key: app.key,
    secret: app.secret,
    activityTimeout: settings.activityTimeout,
    cacheTtlSeconds: settings.cacheTtlSeconds,
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
