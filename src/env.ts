export interface AppBindings extends Env {
  readonly PUSHER_APP_ID: string
  readonly PUSHER_APP_KEY: string
  readonly PUSHER_APP_SECRET: string
  readonly PUSHER_ACTIVITY_TIMEOUT: string | undefined
}
