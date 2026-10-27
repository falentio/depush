import * as v from 'valibot'
import type { AppConfig } from './config'
import type { PresenceMember } from './protocol'
import { channelKind } from './protocol'
import { constantTimeEqual, hmacHex, md5Hex, signingString } from './signature'

export const MAX_TIMESTAMP_SKEW_SECONDS = 600
export const AUTH_VERSION = '1.0'

export type AuthResult = { ok: true } | { ok: false; status: 401; error: string }

export type ChannelAuthResult = { ok: true; presence: PresenceMember | null } | { ok: false }

export type ChannelAuthInput = {
  channel: string
  socketId: string
  auth: string | undefined
  channelData: string | undefined
}

const presenceDataSchema = v.object({
  user_id: v.union([v.pipe(v.string(), v.minLength(1)), v.number()]),
  user_info: v.optional(v.record(v.string(), v.unknown())),
})

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

  const timestampParam = params.get('auth_timestamp')
  if (timestampParam === null || !/^\d+$/.test(timestampParam)) {
    return unauthorized('Invalid auth_timestamp')
  }

  const timestamp = Number(timestampParam)
  if (Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) {
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

export async function verifyChannelAuth(
  input: ChannelAuthInput,
  config: AppConfig,
): Promise<ChannelAuthResult> {
  if (input.auth === undefined) return { ok: false }

  const separator = input.auth.indexOf(':')
  if (separator < 1) return { ok: false }

  if (input.auth.slice(0, separator) !== config.key) return { ok: false }
  const signature = input.auth.slice(separator + 1)

  const presenceChannel = channelKind(input.channel) === 'presence'
  const presence = presenceChannel ? parsePresenceData(input.channelData) : null
  if (presenceChannel && presence === null) return { ok: false }

  const signed =
    presence === null
      ? `${input.socketId}:${input.channel}`
      : `${input.socketId}:${input.channel}:${presence.channelData}`
  const expected = await hmacHex(config.secret, signed)
  if (!constantTimeEqual(expected, signature)) return { ok: false }

  return { ok: true, presence: presence === null ? null : presence.member }
}

function parsePresenceData(
  channelData: string | undefined,
): { channelData: string; member: PresenceMember } | null {
  if (channelData === undefined) return null

  let json: unknown
  try {
    json = JSON.parse(channelData)
  } catch {
    return null
  }

  const parsed = v.safeParse(presenceDataSchema, json)
  if (!parsed.success) return null

  return {
    channelData,
    member: {
      userId: String(parsed.output.user_id),
      userInfo: parsed.output.user_info ?? {},
    },
  }
}

function unauthorized(error: string): AuthResult {
  return { ok: false, status: 401, error }
}
