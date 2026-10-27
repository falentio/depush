import { DurableObject } from 'cloudflare:workers'
import * as v from 'valibot'
import { verifyChannelAuth } from './auth'
import type { AppConfig } from './config'
import { readConfig } from './config'
import type { AppBindings } from './env'
import type { ChannelSnapshot } from './events'
import { dataBytes, MAX_DATA_BYTES } from './events'
import type { ClientFrame, PresenceMember } from './protocol'
import {
  channelEvent,
  channelKind,
  clientEventFrame,
  connectionEstablished,
  errorFrame,
  isOversizedFrame,
  isWebSocketUpgrade,
  memberAdded,
  memberRemoved,
  newSocketId,
  parseFrame,
  pong,
  presenceSubscriptionSucceeded,
  subscriptionSucceeded,
} from './protocol'

const PUSHER_ERROR_BAD_MESSAGE = 4300
const PUSHER_ERROR_RATE_LIMIT = 4301
const PUSHER_ERROR_AUTH_REQUIRED = 4009

export const CLIENT_EVENT_LIMIT = 10
export const CLIENT_EVENT_WINDOW_MS = 1000

export type Subscription = {
  channel: string
  presence?: PresenceMember | undefined
}

export type SocketState = {
  socketId: string
  subscriptions: Subscription[]
}

export type BroadcastInput = {
  name: string
  data: string
  channels: string[]
  exceptSocketId: string | undefined
}

type SubscribeFrame = Extract<ClientFrame, { kind: 'subscribe' }>
type ClientEventFrame = Extract<ClientFrame, { kind: 'client' }>

export class ClientEventLimiter {
  private readonly events = new Map<string, number[]>()

  allow(socketId: string, now: number): boolean {
    const recent = (this.events.get(socketId) ?? []).filter(
      (timestamp) => now - timestamp < CLIENT_EVENT_WINDOW_MS,
    )
    const allowed = recent.length < CLIENT_EVENT_LIMIT

    if (allowed) recent.push(now)
    this.events.set(socketId, recent)
    return allowed
  }

  clear(socketId: string): void {
    this.events.delete(socketId)
  }
}

const presenceMemberSchema = v.object({
  userId: v.string(),
  userInfo: v.record(v.string(), v.unknown()),
})

const subscriptionSchema = v.object({
  channel: v.string(),
  presence: v.optional(presenceMemberSchema),
})

const socketStateSchema = v.object({
  socketId: v.string(),
  subscriptions: v.array(subscriptionSchema),
})

export class AppHub extends DurableObject<AppBindings> {
  private readonly config: AppConfig
  private readonly clientLimiter = new ClientEventLimiter()

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

    const state: SocketState = { socketId: newSocketId(), subscriptions: [] }
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
        if (!isSubscribed(state, channel)) continue
        try {
          socket.send(channelEvent(input.name, channel, input.data))
        } catch {}
      }
    }
  }

  async channelSnapshot(): Promise<ChannelSnapshot> {
    return aggregateChannels(this.socketStates())
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') {
      socket.send(errorFrame('Binary frames are not supported', PUSHER_ERROR_BAD_MESSAGE))
      return
    }

    if (isOversizedFrame(message)) {
      socket.send(errorFrame('Message exceeds 64KB', PUSHER_ERROR_BAD_MESSAGE))
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
        await this.subscribe(socket, parsed.frame)
        return
      case 'unsubscribe':
        this.unsubscribe(socket, parsed.frame.channel)
        return
      case 'client':
        this.clientEvent(socket, parsed.frame)
        return
    }
  }

  override webSocketClose(socket: WebSocket): void {
    const state = readSocketState(socket)
    if (state === null) return

    this.clientLimiter.clear(state.socketId)

    for (const subscription of state.subscriptions) {
      if (subscription.presence === undefined) continue
      this.leavePresence(subscription.channel, subscription.presence.userId, state.socketId)
    }
  }

  override webSocketError(socket: WebSocket): void {
    socket.close(1011, 'WebSocket error')
  }

  private async subscribe(socket: WebSocket, frame: SubscribeFrame): Promise<void> {
    const current = readSocketState(socket)
    if (current === null) return

    const kind = channelKind(frame.channel)
    if (kind === 'encrypted') {
      this.fail(socket, 'Encrypted channels are not supported', PUSHER_ERROR_AUTH_REQUIRED)
      return
    }

    let presence: PresenceMember | null = null
    if (kind !== 'public') {
      const auth = await verifyChannelAuth(
        {
          channel: frame.channel,
          socketId: current.socketId,
          auth: frame.auth,
          channelData: frame.channelData,
        },
        this.config,
      )
      if (!auth.ok) {
        this.fail(socket, 'Invalid channel authorization', PUSHER_ERROR_AUTH_REQUIRED)
        return
      }
      presence = auth.presence
    }

    const state = readSocketState(socket)
    if (state === null) return

    if (isSubscribed(state, frame.channel)) {
      socket.send(this.subscriptionFrame(frame.channel, presence))
      return
    }

    const alreadyPresent =
      presence !== null &&
      collectPresenceMembers(this.socketStates(), frame.channel, state.socketId).some(
        (member) => member.userId === presence.userId,
      )

    const subscription: Subscription =
      presence === null ? { channel: frame.channel } : { channel: frame.channel, presence }
    socket.serializeAttachment({
      ...state,
      subscriptions: [...state.subscriptions, subscription],
    })

    socket.send(this.subscriptionFrame(frame.channel, presence))

    if (presence !== null && !alreadyPresent) {
      this.sendToChannel(frame.channel, memberAdded(frame.channel, presence), state.socketId)
    }
  }

  private unsubscribe(socket: WebSocket, channel: string): void {
    const state = readSocketState(socket)
    if (state === null) return

    const subscription = state.subscriptions.find((entry) => entry.channel === channel)
    if (subscription === undefined) return

    socket.serializeAttachment({
      ...state,
      subscriptions: state.subscriptions.filter((entry) => entry.channel !== channel),
    })

    if (subscription.presence !== undefined) {
      this.leavePresence(channel, subscription.presence.userId, state.socketId)
    }
  }

  private clientEvent(socket: WebSocket, frame: ClientEventFrame): void {
    const state = readSocketState(socket)
    if (state === null) return

    const kind = channelKind(frame.channel)
    const subscription = state.subscriptions.find((entry) => entry.channel === frame.channel)
    if (subscription === undefined || (kind !== 'private' && kind !== 'presence')) {
      socket.send(
        errorFrame(
          'Client events require a private or presence channel subscription',
          PUSHER_ERROR_BAD_MESSAGE,
        ),
      )
      return
    }

    if (dataBytes(frame.data) > MAX_DATA_BYTES) {
      socket.send(errorFrame('Event data exceeds 10KB', PUSHER_ERROR_BAD_MESSAGE))
      return
    }

    if (!this.clientLimiter.allow(state.socketId, Date.now())) {
      socket.send(errorFrame('Client event rate limit exceeded', PUSHER_ERROR_RATE_LIMIT))
      return
    }

    this.sendToChannel(
      frame.channel,
      clientEventFrame({
        name: frame.name,
        channel: frame.channel,
        data: frame.data,
        userId: kind === 'presence' ? subscription.presence?.userId : undefined,
      }),
      state.socketId,
    )
  }

  private leavePresence(channel: string, userId: string, socketId: string): void {
    const remaining = collectPresenceMembers(this.socketStates(), channel, socketId)
    if (remaining.some((member) => member.userId === userId)) return

    this.sendToChannel(channel, memberRemoved(channel, userId), socketId)
  }

  private subscriptionFrame(channel: string, presence: PresenceMember | null): string {
    if (presence === null) return subscriptionSucceeded(channel)

    return presenceSubscriptionSucceeded(
      channel,
      collectPresenceMembers(this.socketStates(), channel, undefined),
    )
  }

  private socketStates(): SocketState[] {
    const states: SocketState[] = []
    for (const socket of this.ctx.getWebSockets()) {
      const state = readSocketState(socket)
      if (state !== null) states.push(state)
    }
    return states
  }

  private sendToChannel(channel: string, frame: string, exceptSocketId: string | undefined): void {
    for (const socket of this.ctx.getWebSockets()) {
      const state = readSocketState(socket)
      if (state === null) continue
      if (state.socketId === exceptSocketId) continue
      if (!isSubscribed(state, channel)) continue
      try {
        socket.send(frame)
      } catch {}
    }
  }

  private fail(socket: WebSocket, message: string, code: number): void {
    socket.send(errorFrame(message, code))
    socket.close(code, message)
  }
}

export function collectPresenceMembers(
  states: SocketState[],
  channel: string,
  exceptSocketId: string | undefined,
): PresenceMember[] {
  const members = new Map<string, PresenceMember>()
  for (const state of states) {
    if (state.socketId === exceptSocketId) continue

    for (const subscription of state.subscriptions) {
      if (subscription.channel !== channel || subscription.presence === undefined) continue
      if (!members.has(subscription.presence.userId)) {
        members.set(subscription.presence.userId, subscription.presence)
      }
    }
  }
  return [...members.values()]
}

export function aggregateChannels(states: SocketState[]): ChannelSnapshot {
  const channels = new Map<string, { subscriptionCount: number; userIds: Set<string> }>()

  for (const state of states) {
    for (const subscription of state.subscriptions) {
      let entry = channels.get(subscription.channel)
      if (entry === undefined) {
        entry = { subscriptionCount: 0, userIds: new Set() }
        channels.set(subscription.channel, entry)
      }
      entry.subscriptionCount += 1
      if (subscription.presence !== undefined) entry.userIds.add(subscription.presence.userId)
    }
  }

  const snapshot: ChannelSnapshot = {}
  for (const [name, entry] of channels) {
    snapshot[name] = {
      subscriptionCount: entry.subscriptionCount,
      userIds: [...entry.userIds].sort(),
    }
  }
  return snapshot
}

function readSocketState(socket: WebSocket): SocketState | null {
  const parsed = v.safeParse(socketStateSchema, socket.deserializeAttachment())
  return parsed.success ? parsed.output : null
}

function isSubscribed(state: SocketState, channel: string): boolean {
  return state.subscriptions.some((subscription) => subscription.channel === channel)
}
