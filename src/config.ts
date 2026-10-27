import * as v from 'valibot'

export type AppConfig = {
  appId: string
  key: string
  secret: string
  activityTimeout: number
}

const DEFAULT_ACTIVITY_TIMEOUT = 120

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

export function readConfig(env: {
  PUSHER_APP_ID: string
  PUSHER_APP_KEY: string
  PUSHER_APP_SECRET: string
  PUSHER_ACTIVITY_TIMEOUT?: string | undefined
}): AppConfig {
  const credentials = v.parse(credentialsSchema, env)
  return {
    appId: credentials.PUSHER_APP_ID,
    key: credentials.PUSHER_APP_KEY,
    secret: credentials.PUSHER_APP_SECRET,
    activityTimeout: readActivityTimeout(env.PUSHER_ACTIVITY_TIMEOUT),
  }
}

function readActivityTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ACTIVITY_TIMEOUT
  const parsed = v.safeParse(activityTimeoutSchema, raw)
  return parsed.success ? parsed.output : DEFAULT_ACTIVITY_TIMEOUT
}
