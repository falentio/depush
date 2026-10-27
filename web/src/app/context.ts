import { createApi } from '@/api/client'
import { createHttp } from '@/api/http'
import { type AuthStore, createAuthStore } from '@/auth/store'

export type Api = ReturnType<typeof createApi>

export type ConsoleApp = {
  api: Api
  authStore: AuthStore
}

export type RouterContext = ConsoleApp

export function createApp(): ConsoleApp {
  const http = createHttp()
  const api = createApi(http)
  const authStore = createAuthStore(api.auth)
  http.onSessionExpired(() => {
    void authStore.expire()
  })
  return { api, authStore }
}
