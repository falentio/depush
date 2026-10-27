import type { AppConfig } from './config'
import { constantTimeEqual, hmacHex, md5Hex, signingString } from './signature'

export const MAX_TIMESTAMP_SKEW_SECONDS = 600
export const AUTH_VERSION = '1.0'

export type AuthResult = { ok: true } | { ok: false; status: 401; error: string }

export async function verifyRequest(
  request: Request,
  body: Uint8Array,
  config: AppConfig,
  nowSeconds: number,
): Promise<AuthResult> {
  const url = new URL(request.url)
  const params = url.searchParams

  if (params.get('auth_key') !== config.key) {
    return unauthorized('Invalid auth_key')
  }

  if (params.get('auth_version') !== AUTH_VERSION) {
    return unauthorized('Invalid auth_version')
  }

  const timestamp = Number.parseInt(params.get('auth_timestamp') ?? '', 10)
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS
  ) {
    return unauthorized('Invalid auth_timestamp')
  }

  if (body.length > 0 && params.get('body_md5') !== md5Hex(body)) {
    return unauthorized('Invalid body_md5')
  }

  const signature = params.get('auth_signature')
  if (signature === null) {
    return unauthorized('Missing auth_signature')
  }

  const expected = await hmacHex(config.secret, signingString(request.method, url.pathname, params))
  if (!constantTimeEqual(expected, signature)) {
    return unauthorized('Invalid auth_signature')
  }

  return { ok: true }
}

function unauthorized(error: string): AuthResult {
  return { ok: false, status: 401, error }
}
