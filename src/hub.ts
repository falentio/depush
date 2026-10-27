import { DurableObject } from 'cloudflare:workers'
import * as v from 'valibot'
import type { AppConfig } from './config'
import { readConfig } from './config'
import type { AppBindings } from './env'
import {
  channelEvent,
  connectionEstablished,
  errorFrame,
  isWebSocketUpgrade,
  newSocketId,
  parseFrame,
  pong,
  subscriptionSucceeded,
} from './protocol'

const AUTH_CHANNEL_PREFIXES = ['private-', 'presence-', 'private-encrypted-']
const PUSHER_ERROR_BAD_MESSAGE = 4300
const PUSHER_ERROR_AUTH_REQUIRED = 4009

type SocketState = {
  socketId: string
  channels: string[]
}

export type BroadcastInput = {
  name: string
  data: string
  channels: string[]
  exceptSocketId: string | undefined
}

const socketStateSchema = v.object({
  socketId: v.string(),
  channels: v.array(v.string()),
})

export class AppHub extends DurableObject<AppBindings> {
  private readonly config: AppConfig

  constructor(ctx: DurableObjectState, env: AppBindings) {
    super(ctx, env)
    this.config = readConfig(env)
  }

  override async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const server = pair[1]
    this.ctx.acceptWebSocket(server)

    const state: SocketState = { socketId: newSocketId(), channels: [] }
    server.serializeAttachment(state)
    server.send(connectionEstablished(state.socketId, this.config.activityTimeout))

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async broadcast(input: BroadcastInput): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      const state = readSocketState(socket)
      if (state === null) continue
      if (state.socketId === input.exceptSocketId) continue

      for (const channel of input.channels) {
        if (!state.channels.includes(channel)) continue
        try {
          socket.send(channelEvent(input.name, channel, input.data))
        } catch {}
      }
    }
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') {
      socket.send(errorFrame('Binary frames are not supported', PUSHER_ERROR_BAD_MESSAGE))
      return
    }

    const parsed = parseFrame(message)
    if (!parsed.ok) {
      socket.send(errorFrame('Invalid message', PUSHER_ERROR_BAD_MESSAGE))
      return
    }

    switch (parsed.frame.kind) {
      case 'ping':
        socket.send(pong())
        return
      case 'pong':
        return
      case 'subscribe':
        this.subscribe(socket, parsed.frame.channel)
        return
      case 'unsubscribe':
        this.unsubscribe(socket, parsed.frame.channel)
        return
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason)
  }

  override webSocketError(socket: WebSocket): void {
    socket.close(1011, 'WebSocket error')
  }

  private subscribe(socket: WebSocket, channel: string): void {
    if (requiresAuthorization(channel)) {
      socket.send(errorFrame('Channel requires authorization', PUSHER_ERROR_AUTH_REQUIRED))
      return
    }

    const state = readSocketState(socket)
    if (state === null) return

    if (!state.channels.includes(channel)) {
      socket.serializeAttachment({ ...state, channels: [...state.channels, channel] })
    }
    socket.send(subscriptionSucceeded(channel))
  }

  private unsubscribe(socket: WebSocket, channel: string): void {
    const state = readSocketState(socket)
    if (state === null) return

    if (state.channels.includes(channel)) {
      socket.serializeAttachment({
        ...state,
        channels: state.channels.filter((subscribed) => subscribed !== channel),
      })
    }
  }
}

function readSocketState(socket: WebSocket): SocketState | null {
  const parsed = v.safeParse(socketStateSchema, socket.deserializeAttachment())
  return parsed.success ? parsed.output : null
}

function requiresAuthorization(channel: string): boolean {
  return AUTH_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))
}
