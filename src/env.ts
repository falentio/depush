export interface AppBindings extends Env {
  readonly BETTER_AUTH_SECRET: string | undefined
  readonly BETTER_AUTH_URL: string | undefined
  readonly PUSHER_ACTIVITY_TIMEOUT: string | undefined
  readonly PUSHER_CACHE_TTL_SECONDS: string | undefined
}
