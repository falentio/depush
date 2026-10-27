import type { AppId } from './contracts'
import { appSchema, appsSchema, issuedAppSchema, sessionSchema, settingsSchema } from './contracts'
import type { ApiPath, Http } from './http'

export type Credentials = { email: string; password: string }
export type SignUpInput = Credentials & { name: string }

export function createApi(http: Http) {
  return {
    apps: {
      list: () => http.json('GET', '/api/apps', appsSchema),
      create: (name: string) => http.json('POST', '/api/apps', issuedAppSchema, { body: { name } }),
      rename: (id: AppId, name: string) =>
        http.json('PATCH', appPath(id), appSchema, { body: { name } }),
      remove: (id: AppId) => http.empty('DELETE', appPath(id)),
    },
    settings: {
      read: () => http.json('GET', '/api/settings', settingsSchema),
      write: (signupEnabled: boolean) =>
        http.json('PATCH', '/api/settings', settingsSchema, {
          body: { signup_enabled: signupEnabled },
        }),
    },
    auth: {
      readSession: () =>
        http.json('GET', '/api/auth/get-session', sessionSchema, { expireSession: false }),
      signIn: (input: Credentials) =>
        http.empty('POST', '/api/auth/sign-in/email', { body: input, expireSession: false }),
      signUp: (input: SignUpInput) =>
        http.empty('POST', '/api/auth/sign-up/email', { body: input, expireSession: false }),
      signOut: () => http.empty('POST', '/api/auth/sign-out', { body: {}, expireSession: false }),
    },
  }
}

export type Api = ReturnType<typeof createApi>

function appPath(id: AppId): ApiPath {
  return `/api/apps/${encodeURIComponent(id)}`
}
