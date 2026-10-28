import { DurableObject } from 'cloudflare:workers'
import type { Logger } from '@logtape/logtape'
import * as v from 'valibot'
import { verifyChannelAuth } from './auth'
import { type Channel, channelObjectName } from './channel'
import type { AppConfig } from './config'
import { readSettings } from './config'
import type { AppBindings } from './env'
import type { ChannelSnapshot } from './events'
import { dataBytes, MAX_DATA_BYTES } from './events'
import { log } from './logging'
import type { ClientFrame, PresenceMember, PresenceState } from './protocol'
import {
  cacheMiss,
  channelEvent,
  channelKind,
  clientEventFrame,
  connectionEstablished,
  errorFrame,
  isCacheChannel,
  isOversizedFrame,
  isWebSocketUpgrade,
  memberAdded,
  memberRemoved,
  newSocketId,
  parseFrame,
  pong,
  presenceState,
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
  connectedAt?: number | undefined
  subscriptions: Subscription[]
}

export type BroadcastInput = {
  name: string
  data: string
  channels: string[]
  userId: string | null
  cache: boolean
  exceptSocketId: string | undefined
}

type RecordedEvent = {
  name: string
  data: string
  userId: string | null
  cache: boolean
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
  connectedAt: v.optional(v.number()),
  subscriptions: v.array(subscriptionSchema),
})

const SUBSCRIBE_REFUSALS = {
  encrypted_channel: {
    message: 'Encrypted channels are not supported',
    code: PUSHER_ERROR_AUTH_REQUIRED,
  },
  hub_not_initialized: {
    message: 'AppHub is not initialized',
    code: PUSHER_ERROR_AUTH_REQUIRED,
  },
  invalid_auth: {
    message: 'Invalid channel authorization',
    code: PUSHER_ERROR_AUTH_REQUIRED,
  },
} as const

const CLIENT_EVENT_REFUSALS = {
  not_subscribed: {
    message: 'Client events require a private or presence channel subscription',
    code: PUSHER_ERROR_BAD_MESSAGE,
  },
  data_too_large: { message: 'Event data exceeds 10KB', code: PUSHER_ERROR_BAD_MESSAGE },
  rate_limited: { message: 'Client event rate limit exceeded', code: PUSHER_ERROR_RATE_LIMIT },
} as const

export class AppHub extends DurableObject<AppBindings> {
  private config: AppConfig | null = null
  private readonly clientLimiter = new ClientEventLimiter()
  private readonly log: Logger

  constructor(ctx: DurableObjectState, env: AppBindings) {
    super(ctx, env)
    this.log = log.hub.with({ appId: this.ctx.id.name ?? 'unknown' })
  }

  /**
   * Only the WebSocket upgrade needs the key and secret, so the Worker hands
   * the resolved config in there. Publish and query calls never touch it.
   */
  init(config: AppConfig): void {
    this.config = config
  }

  override async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const config = this.config
    if (config === null) {
      this.log.warn('hub_not_initialized', { status: 503 })
      return new Response('AppHub is not initialized', { status: 503 })
    }

    const pair = new WebSocketPair()
    const server = pair[1]
    this.ctx.acceptWebSocket(server)

    const state: SocketState = {
      socketId: newSocketId(),
      connectedAt: Date.now(),
      subscriptions: [],
    }
    server.serializeAttachment(state)
    server.send(connectionEstablished(state.socketId, config.activityTimeout))
    this.log.debug('socket_opened', { socketId: state.socketId })

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async broadcast(input: BroadcastInput): Promise<void> {
    for (const channel of input.channels) {
      await this.recordEvent(channel, {
        name: input.name,
        data: input.data,
        userId: input.userId,
        cache: input.cache,
      })
    }

    const delivered = new Map<string, { subscribers: number; failed: number }>()

    for (const socket of this.ctx.getWebSockets()) {
      const state = readSocketState(socket)
      if (state === null) {
        this.log.warn('socket_state_unreadable')
        continue
      }
      if (state.socketId === input.exceptSocketId) continue

      for (const channel of input.channels) {
        if (!isSubscribed(state, channel)) continue
        const tally = delivered.get(channel) ?? { subscribers: 0, failed: 0 }
        tally.subscribers += 1
        if (!this.deliver(socket, channelEvent(input.name, channel, input.data))) tally.failed += 1
        delivered.set(channel, tally)
      }
    }

    for (const channel of new Set(input.channels)) {
      const tally = delivered.get(channel) ?? { subscribers: 0, failed: 0 }
      this.log.info('publish', {
        channel,
        event: input.name,
        subscribers: tally.subscribers,
        failed: tally.failed,
        cached: input.cache && isCacheChannel(channel),
      })
    }
  }

  async channelSnapshot(): Promise<ChannelSnapshot> {
    return aggregateChannels(this.socketStates())
  }

  async presenceInfo(channel: string): Promise<PresenceState | null> {
    if (channelKind(channel) !== 'presence') return null

    return presenceState(collectPresenceMembers(this.socketStates(), channel, undefined))
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const socketId = readSocketState(socket)?.socketId

    try {
      if (typeof message !== 'string') {
        this.log.warn('frame_refused', { socketId, reason: 'binary_frame' })
        socket.send(errorFrame('Binary frames are not supported', PUSHER_ERROR_BAD_MESSAGE))
        return
      }

      if (isOversizedFrame(message)) {
        this.log.warn('frame_refused', { socketId, reason: 'oversized_frame' })
        socket.send(errorFrame('Message exceeds 64KB', PUSHER_ERROR_BAD_MESSAGE))
        return
      }

      const parsed = parseFrame(message)
      if (!parsed.ok) {
        this.log.warn('frame_refused', { socketId, reason: 'malformed_frame' })
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
          await this.clientEvent(socket, parsed.frame)
          return
      }
    } catch (error) {
      this.log.error('unhandled', { socketId, error })
      throw error
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    const state = readSocketState(socket)
    if (state === null) return

    this.clientLimiter.clear(state.socketId)

    for (const subscription of state.subscriptions) {
      if (subscription.presence === undefined) continue
      this.leavePresence(subscription.channel, subscription.presence.userId, state.socketId)
    }

    this.log.info('socket_closed', {
      socketId: state.socketId,
      closeCode: code,
      closeReason: reason,
      subscriptions: state.subscriptions.length,
      ...(state.connectedAt === undefined ? {} : { socketMs: Date.now() - state.connectedAt }),
    })
  }

  override webSocketError(socket: WebSocket): void {
    this.log.warn('socket_error', { socketId: readSocketState(socket)?.socketId })
    socket.close(1011, 'WebSocket error')
  }

  private async subscribe(socket: WebSocket, frame: SubscribeFrame): Promise<void> {
    const current = readSocketState(socket)
    if (current === null) return

    const kind = channelKind(frame.channel)
    if (kind === 'encrypted') {
      this.subscribeRefused(socket, current.socketId, frame.channel, 'encrypted_channel')
      return
    }

    let presence: PresenceMember | null = null
    if (kind !== 'public') {
      const config = this.config
      if (config === null) {
        this.subscribeRefused(socket, current.socketId, frame.channel, 'hub_not_initialized')
        return
      }
      const auth = await verifyChannelAuth(
        {
          channel: frame.channel,
          socketId: current.socketId,
          auth: frame.auth,
          channelData: frame.channelData,
        },
        config,
      )
      if (!auth.ok) {
        this.subscribeRefused(socket, current.socketId, frame.channel, 'invalid_auth')
        return
      }
      presence = auth.presence
    }

    const state = readSocketState(socket)
    if (state === null) return

    if (isSubscribed(state, frame.channel)) {
      socket.send(this.subscriptionFrame(frame.channel, presence))
      await this.deliverCache(socket, frame.channel)
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
    this.log.debug('subscribed', { socketId: state.socketId, channel: frame.channel })

    socket.send(this.subscriptionFrame(frame.channel, presence))
    await this.deliverCache(socket, frame.channel)

    if (presence !== null && !alreadyPresent) {
      this.log.debug('presence_member', {
        channel: frame.channel,
        userId: presence.userId,
        change: 'added',
      })
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
    this.log.debug('unsubscribed', { socketId: state.socketId, channel })

    if (subscription.presence !== undefined) {
      this.leavePresence(channel, subscription.presence.userId, state.socketId)
    }
  }

  private async clientEvent(socket: WebSocket, frame: ClientEventFrame): Promise<void> {
    const state = readSocketState(socket)
    if (state === null) return

    const kind = channelKind(frame.channel)
    const subscription = state.subscriptions.find((entry) => entry.channel === frame.channel)
    if (subscription === undefined || (kind !== 'private' && kind !== 'presence')) {
      this.clientEventRefused(socket, state.socketId, frame.channel, 'not_subscribed')
      return
    }

    if (dataBytes(frame.data) > MAX_DATA_BYTES) {
      this.clientEventRefused(socket, state.socketId, frame.channel, 'data_too_large')
      return
    }

    if (!this.clientLimiter.allow(state.socketId, Date.now())) {
      this.clientEventRefused(socket, state.socketId, frame.channel, 'rate_limited')
      return
    }

    await this.recordEvent(frame.channel, {
      name: frame.name,
      data: typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data ?? null),
      userId: kind === 'presence' ? (subscription.presence?.userId ?? null) : null,
      cache: false,
    })

    const fanOut = this.sendToChannel(
      frame.channel,
      clientEventFrame({
        name: frame.name,
        channel: frame.channel,
        data: frame.data,
        userId: kind === 'presence' ? subscription.presence?.userId : undefined,
      }),
      state.socketId,
    )
    this.log.debug('client_event', {
      socketId: state.socketId,
      channel: frame.channel,
      event: frame.name,
      subscribers: fanOut.subscribers,
      failed: fanOut.failed,
    })
  }

  private leavePresence(channel: string, userId: string, socketId: string): void {
    const remaining = collectPresenceMembers(this.socketStates(), channel, socketId)
    if (remaining.some((member) => member.userId === userId)) return

    this.sendToChannel(channel, memberRemoved(channel, userId), socketId)
    this.log.debug('presence_member', { channel, userId, change: 'removed' })
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

  private sendToChannel(
    channel: string,
    frame: string,
    exceptSocketId: string | undefined,
  ): { subscribers: number; failed: number } {
    let subscribers = 0
    let failed = 0

    for (const socket of this.ctx.getWebSockets()) {
      const state = readSocketState(socket)
      if (state === null) continue
      if (state.socketId === exceptSocketId) continue
      if (!isSubscribed(state, channel)) continue
      subscribers += 1
      if (!this.deliver(socket, frame)) failed += 1
    }

    return { subscribers, failed }
  }

  private deliver(socket: WebSocket, frame: string): boolean {
    try {
      socket.send(frame)
      return true
    } catch {
      return false
    }
  }

  private channelState(channel: string): DurableObjectStub<Channel> {
    const appId = this.ctx.id.name
    if (appId === undefined) throw new Error('AppHub is not addressed by app id')
    return this.env.CHANNEL.get(this.env.CHANNEL.idFromName(channelObjectName(appId, channel)))
  }

  private async recordEvent(channel: string, input: RecordedEvent): Promise<void> {
    await this.channelState(channel).record({
      name: input.name,
      data: input.data,
      userId: input.userId,
      cache: input.cache && isCacheChannel(channel),
      ttlSeconds: readSettings(this.env).cacheTtlSeconds,
    })
  }

  private async deliverCache(socket: WebSocket, channel: string): Promise<void> {
    if (!isCacheChannel(channel)) return

    const cached = await this.channelState(channel).snapshot()
    this.log.debug('cache_replay', { channel, cached: cached !== null })
    socket.send(
      cached === null ? cacheMiss(channel) : channelEvent(cached.name, channel, cached.data),
    )
  }

  private subscribeRefused(
    socket: WebSocket,
    socketId: string,
    channel: string,
    reason: keyof typeof SUBSCRIBE_REFUSALS,
  ): void {
    const refusal = SUBSCRIBE_REFUSALS[reason]
    this.log.warn('subscribe_refused', { socketId, channel, reason, code: refusal.code })
    this.fail(socket, refusal.message, refusal.code)
  }

  private clientEventRefused(
    socket: WebSocket,
    socketId: string,
    channel: string,
    reason: keyof typeof CLIENT_EVENT_REFUSALS,
  ): void {
    const refusal = CLIENT_EVENT_REFUSALS[reason]
    this.log.warn('client_event_refused', { socketId, channel, reason, code: refusal.code })
    socket.send(errorFrame(refusal.message, refusal.code))
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
