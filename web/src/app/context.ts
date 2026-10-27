import { createApi } from '@/api/client'
import { createHttp } from '@/api/http'
import { type AuthStore, createAuthStore } from '@/auth/store'

export type Api = ReturnType<typeof createApi>

export type ConsoleApp = {
  api: Api
  authStore: AuthStore
}

export type RouterContext = ConsoleApp

/**
 * The one place the transport, the API, and the auth store meet. The HTTP layer
 * reports a 401 from an admin path to the store; `/api/auth/*` is excluded there.
 */
export function createApp(): ConsoleApp {
  const http = createHttp()
  const api = createApi(http)
  const authStore = createAuthStore(api.auth)
  http.onSessionExpired(authStore.expire)
  return { api, authStore }
}
