import * as v from 'valibot'

export type ClientFrame =
  | { kind: 'ping' }
  | { kind: 'pong' }
  | { kind: 'subscribe'; channel: string }
  | { kind: 'unsubscribe'; channel: string }

export type FrameParse = { ok: true; frame: ClientFrame } | { ok: false }

const channelName = v.pipe(v.string(), v.minLength(1))

const frameSchema = v.variant('event', [
  v.object({ event: v.literal('pusher:ping') }),
  v.object({ event: v.literal('pusher:pong') }),
  v.object({
    event: v.literal('pusher:subscribe'),
    data: v.object({ channel: channelName }),
  }),
  v.object({
    event: v.literal('pusher:unsubscribe'),
    data: v.object({ channel: channelName }),
  }),
])

export function parseFrame(raw: string): FrameParse {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false }
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
      return { ok: true, frame: { kind: 'subscribe', channel: frame.data.channel } }
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

export function channelEvent(name: string, channel: string, data: string): string {
  return JSON.stringify({ event: name, channel, data })
}

export function errorFrame(message: string, code: number): string {
  return JSON.stringify({ event: 'pusher:error', data: { message, code } })
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
