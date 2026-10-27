import { randomBytes } from 'node:crypto'

export const BETTER_AUTH_SECRET = 'depush-local-test-better-auth-secret'

const OWNER_EMAIL = 'owner@depush.local'
const OWNER_PASSWORD = 'depush-local-owner-password'

export const DEV_VARS_CONTENT = (settings = {}) =>
  [
    `BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}`,
    `PUSHER_ACTIVITY_TIMEOUT=${settings.activityTimeout ?? 120}`,
    `PUSHER_CACHE_TTL_SECONDS=${settings.cacheTtl ?? 1800}`,
    '',
  ].join('\n')

async function call(baseUrl, path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { origin: baseUrl, ...init?.headers },
  })
  const text = await response.text()
  let body = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = text
  }
  return { response, body }
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') ?? ''
  const cookie = raw.split(';')[0] ?? ''
  if (cookie === '') throw new Error('the auth response did not set a session cookie')
  return cookie
}

/**
 * Bootstraps a local server the way an operator would: the owner account exists
 * (first sign-up becomes admin), then the app is created through the admin API.
 * Nothing app-specific lives in env.
 */
export async function bootstrap(baseUrl, appName = 'compat') {
  const signUp = await call(baseUrl, '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: 'Owner' }),
  })

  let cookie
  if (signUp.response.status === 200) {
    cookie = cookieFrom(signUp.response)
  } else {
    const signIn = await call(baseUrl, '/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    })
    if (signIn.response.status !== 200) {
      throw new Error(
        `could not reach an owner account (sign-up ${signUp.response.status}, sign-in ${signIn.response.status}); ` +
          'remove .wrangler/state for a clean local registry',
      )
    }
    cookie = cookieFrom(signIn.response)
  }

  const created = await call(baseUrl, '/api/apps', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: `${appName}-${randomBytes(3).toString('hex')}` }),
  })
  if (created.response.status !== 201) {
    throw new Error(
      `app create failed with ${created.response.status}: ${JSON.stringify(created.body)}; ` +
        'remove .wrangler/state/v3/do/depush-Registry for a clean local registry',
    )
  }

  const app = created.body
  return { appId: app.id, key: app.key, secret: app.secret, cookie }
}
