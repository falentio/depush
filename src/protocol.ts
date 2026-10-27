import * as v from 'valibot'

export type ClientFrame =
  | { kind: 'ping' }
  | { kind: 'pong' }
  | {
      kind: 'subscribe'
      channel: string
      auth?: string | undefined
      channelData?: string | undefined
    }
  | { kind: 'unsubscribe'; channel: string }
  | { kind: 'client'; name: string; channel: string; data: unknown }

export type ClientEventBroadcast = {
  name: string
  channel: string
  data: unknown
  userId: string | undefined
}

export const CLIENT_EVENT_PREFIX = 'client-'
export const MAX_EVENT_NAME = 200
export const MAX_CHANNEL_NAME = 200
export const MAX_FRAME_BYTES = 64 * 1024

const channelNamePattern = new RegExp(`^[A-Za-z0-9_=@,.;-]{1,${MAX_CHANNEL_NAME}}$`)

const encoder = new TextEncoder()

export type ChannelKind = 'public' | 'private' | 'presence' | 'encrypted'

export type PresenceMember = {
  userId: string
  userInfo: Record<string, unknown>
}

export type FrameParse = { ok: true; frame: ClientFrame } | { ok: false }

export const channelNameSchema = v.pipe(
  v.string(),
  v.regex(channelNamePattern, 'Invalid channel name'),
)

export function isValidChannelName(name: string): boolean {
  return v.safeParse(channelNameSchema, name).success
}

export function isOversizedFrame(frame: string): boolean {
  return encoder.encode(frame).byteLength > MAX_FRAME_BYTES
}

const envelopeSchema = v.object({ event: v.string() })

const clientFrameSchema = v.object({
  event: v.pipe(v.string(), v.startsWith(CLIENT_EVENT_PREFIX), v.maxLength(MAX_EVENT_NAME)),
  channel: channelNameSchema,
  data: v.optional(v.unknown()),
})

const frameSchema = v.variant('event', [
  v.object({ event: v.literal('pusher:ping') }),
  v.object({ event: v.literal('pusher:pong') }),
  v.object({
    event: v.literal('pusher:subscribe'),
    data: v.object({
      channel: channelNameSchema,
      auth: v.optional(v.string()),
      channel_data: v.optional(v.string()),
    }),
  }),
  v.object({
    event: v.literal('pusher:unsubscribe'),
    data: v.object({ channel: channelNameSchema }),
  }),
])

export function parseFrame(raw: string): FrameParse {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false }
  }

  const envelope = v.safeParse(envelopeSchema, json)
  if (!envelope.success) return { ok: false }

  if (envelope.output.event.startsWith(CLIENT_EVENT_PREFIX)) {
    const parsed = v.safeParse(clientFrameSchema, json)
    if (!parsed.success) return { ok: false }
    return {
      ok: true,
      frame: {
        kind: 'client',
        name: parsed.output.event,
        channel: parsed.output.channel,
        data: parsed.output.data,
      },
    }
  }

  const parsed = v.safeParse(frameSchema, json)
  if (!parsed.success) return { ok: false }

  const frame = parsed.output
  switch (frame.event) {
    case 'pusher:ping':
      return { ok: true, frame: { kind: 'ping' } }
    case 'pusher:pong':
      return { ok: true, frame: { kind: 'pong' } }
    case 'pusher:subscribe':
      return {
        ok: true,
        frame: {
          kind: 'subscribe',
          channel: frame.data.channel,
          auth: frame.data.auth,
          channelData: frame.data.channel_data,
        },
      }
    case 'pusher:unsubscribe':
      return { ok: true, frame: { kind: 'unsubscribe', channel: frame.data.channel } }
  }
}

export function newSocketId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const view = new DataView(bytes.buffer)
  return `${view.getUint32(0) % 1_000_000_000}.${view.getUint32(4) % 1_000_000_000}`
}

export function connectionEstablished(socketId: string, activityTimeout: number): string {
  return JSON.stringify({
    event: 'pusher:connection_established',
    data: JSON.stringify({ socket_id: socketId, activity_timeout: activityTimeout }),
  })
}

export function pong(): string {
  return JSON.stringify({ event: 'pusher:pong', data: '{}' })
}

export function subscriptionSucceeded(channel: string): string {
  return JSON.stringify({
    event: 'pusher_internal:subscription_succeeded',
    channel,
    data: '{}',
  })
}

export function presenceSubscriptionSucceeded(channel: string, members: PresenceMember[]): string {
  const hash = Object.fromEntries(members.map((member) => [member.userId, member.userInfo]))
  return JSON.stringify({
    event: 'pusher_internal:subscription_succeeded',
    channel,
    data: JSON.stringify({
      presence: { ids: members.map((member) => member.userId), hash, count: members.length },
    }),
  })
}

export function memberAdded(channel: string, member: PresenceMember): string {
  return JSON.stringify({
    event: 'pusher_internal:member_added',
    channel,
    data: JSON.stringify({ user_id: member.userId, user_info: member.userInfo }),
  })
}

export function memberRemoved(channel: string, userId: string): string {
  return JSON.stringify({
    event: 'pusher_internal:member_removed',
    channel,
    data: JSON.stringify({ user_id: userId }),
  })
}

export function channelKind(channel: string): ChannelKind {
  if (channel.startsWith('private-encrypted-')) return 'encrypted'
  if (channel.startsWith('private-')) return 'private'
  if (channel.startsWith('presence-')) return 'presence'
  return 'public'
}

const CACHE_CHANNEL_PREFIXES = ['private-cache-', 'presence-cache-', 'cache-']

export function isCacheChannel(channel: string): boolean {
  return CACHE_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))
}

export function channelEvent(name: string, channel: string, data: string): string {
  return JSON.stringify({ event: name, channel, data })
}

export function clientEventFrame(input: ClientEventBroadcast): string {
  const frame: Record<string, unknown> = {
    event: input.name,
    channel: input.channel,
    data: input.data,
  }
  if (input.userId !== undefined) frame.user_id = input.userId
  return JSON.stringify(frame)
}

export function errorFrame(message: string, code: number): string {
  return JSON.stringify({ event: 'pusher:error', data: { message, code } })
}

export function cacheMiss(channel: string): string {
  return JSON.stringify({ event: 'pusher:cache_miss', channel, data: '{}' })
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
}

export function upgradeRejected(request: Request, code: number, message: string): Response {
  if (!isWebSocketUpgrade(request)) {
    return new Response(message, { status: 400 })
  }

  const pair = new WebSocketPair()
  const server = pair[1]
  server.accept()
  server.send(errorFrame(message, code))
  server.close(code, message)
  return new Response(null, { status: 101, webSocket: pair[0] })
}
