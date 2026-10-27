import { exports } from 'cloudflare:workers'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

const ORIGIN = 'http://depush.test'
const PASSWORD = 'correct-horse-battery-staple'

const signUpBodySchema = v.object({
  user: v.object({ email: v.string(), role: v.nullish(v.string()) }),
})

type SignUp = { status: number; role: string | null; cookie: string }

function signUp(email: string) {
  return exports.default.fetch(`${ORIGIN}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  })
}

async function attemptSignUp(email: string): Promise<SignUp> {
  const response = await signUp(email)
  const parsed = v.safeParse(signUpBodySchema, await response.json())
  return {
    status: response.status,
    role: parsed.success ? (parsed.output.user.role ?? null) : null,
    cookie: (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
  }
}

function as(cookie: string, path: string) {
  return exports.default.fetch(`${ORIGIN}${path}`, { headers: { cookie } })
}

/**
 * The file shares one registry, so the claim is one scenario: two concurrent
 * first sign-ups, then a later one. Split across tests, the roles would depend
 * on which test ran first.
 */
describe('the admin claim', () => {
  it('gives one of two concurrent first sign-ups admin and every later one user', async () => {
    const [a, b] = await Promise.all([
      attemptSignUp('race-a@example.com'),
      attemptSignUp('race-b@example.com'),
    ])

    expect([a.status, b.status]).toEqual([200, 200])
    expect([a.role, b.role].sort()).toEqual(['admin', 'user'])

    const admin = [a, b].find((attempt) => attempt.role === 'admin')
    const user = [a, b].find((attempt) => attempt.role === 'user')
    if (admin === undefined || user === undefined) throw new Error('the race had no winner')

    expect((await as(admin.cookie, '/api/apps')).status).toBe(200)
    expect(await (await as(admin.cookie, '/api/settings')).json()).toEqual({ signup_enabled: true })
    expect((await as(user.cookie, '/api/apps')).status).toBe(403)

    const later = await attemptSignUp('later@example.com')
    expect(later.status).toBe(200)
    expect(later.role).toBe('user')
    expect((await as(later.cookie, '/api/apps')).status).toBe(403)
  })
})
