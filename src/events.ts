import * as v from 'valibot'
import type { ChannelKind } from './protocol'
import { channelKind, channelNameSchema, MAX_EVENT_NAME } from './protocol'

export const MAX_DATA_BYTES = 10 * 1024
export const MAX_CHANNELS = 100
export const MAX_BATCH_EVENTS = 10

const encoder = new TextEncoder()

export type Trigger = {
  name: string
  data: string
  channels: string[]
  socketId: string | undefined
}

export type BatchEvent = {
  name: string
  channel: string
  data: string
  socketId: string | undefined
}

type ParseFailure = { ok: false; status: 400 | 413; error: string }

export type TriggerResult = { ok: true; trigger: Trigger } | ParseFailure

export type BatchResult = { ok: true; events: BatchEvent[] } | ParseFailure

export const DEFAULT_HISTORY_LIMIT = 50
export const MAX_HISTORY_LIMIT = 100

export type HistoryEvent = {
  id: number
  name: string
  data: string
  user_id?: string
  published_at: string
}

export type HistoryPage = {
  events: HistoryEvent[]
  next_cursor: string | null
}

export type HistoryQuery = {
  limit: number
  before: number | undefined
}

export type HistoryQueryParse = { ok: true; query: HistoryQuery } | { ok: false; error: string }

export type ChannelInfoRequest = {
  userCount: boolean
  subscriptionCount: boolean
  cache: boolean
}

export type ChannelInfoParse = { ok: true; info: ChannelInfoRequest } | { ok: false; error: string }

export type ChannelSnapshotEntry = {
  subscriptionCount: number
  userIds: string[]
}

export type ChannelSnapshot = Record<string, ChannelSnapshotEntry>

export type ChannelAttributes = {
  user_count?: number
  subscription_count?: number
}

export type ChannelListResult =
  | { ok: true; body: { channels: Record<string, ChannelAttributes> } }
  | { ok: false; error: string }

export type ChannelInfoResult =
  | { ok: true; body: { occupied: boolean } & ChannelAttributes }
  | { ok: false; error: string }

export type ChannelUsersResult =
  | { ok: true; body: { users: { id: string }[] } }
  | { ok: false; error: string }

const eventName = v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_EVENT_NAME))
const socketId = v.pipe(v.string(), v.regex(/^\d+\.\d+$/))

const eventFields = {
  name: eventName,
  data: v.string(),
  socket_id: v.optional(socketId),
}

const triggerFields = { ...eventFields, info: v.optional(v.unknown()) }

const triggerSchema = v.union([
  v.object({
    ...triggerFields,
    channels: v.pipe(v.array(channelNameSchema), v.minLength(1), v.maxLength(MAX_CHANNELS)),
  }),
  v.object({ ...triggerFields, channel: channelNameSchema }),
])

const batchEventSchema = v.object({
  ...eventFields,
  channel: channelNameSchema,
  info: v.optional(v.unknown()),
})

const batchSchema = v.object({
  batch: v.pipe(v.array(batchEventSchema), v.minLength(1), v.maxLength(MAX_BATCH_EVENTS)),
})

const historyLimitSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform(Number),
  v.integer(),
  v.minValue(1),
  v.maxValue(MAX_HISTORY_LIMIT),
)

const historyBeforeSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/),
  v.transform(Number),
  v.integer(),
  v.minValue(1),
)

const INFO_ATTRIBUTES = new Map<string, 'userCount' | 'subscriptionCount' | 'cache'>([
  ['user_count', 'userCount'],
  ['subscription_count', 'subscriptionCount'],
  ['cache', 'cache'],
])

export function parseTrigger(body: Uint8Array, infoQuery: string | undefined): TriggerResult {
  if (infoQuery !== undefined) {
    return invalid('Single-event info is not supported')
  }

  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return invalid('Body must be JSON')
  }

  const parsed = v.safeParse(triggerSchema, json)
  if (!parsed.success) {
    return invalid('Invalid event payload')
  }

  const event = parsed.output
  if (event.info !== undefined) {
    return invalid('Single-event info is not supported')
  }

  const channels = 'channels' in event ? event.channels : [event.channel]
  if (channels.some((channel) => channelKind(channel) === 'encrypted')) {
    return invalid('Encrypted channels are not supported')
  }

  if (dataBytes(event.data) > MAX_DATA_BYTES) {
    return { ok: false, status: 413, error: 'Event data exceeds 10KB' }
  }

  return {
    ok: true,
    trigger: {
      name: event.name,
      data: event.data,
      channels,
      socketId: event.socket_id,
    },
  }
}

export function parseBatch(body: Uint8Array): BatchResult {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return invalid('Body must be JSON')
  }

  const parsed = v.safeParse(batchSchema, json)
  if (!parsed.success) {
    return invalid('Invalid batch payload')
  }

  const events: BatchEvent[] = []
  for (const event of parsed.output.batch) {
    if (event.info !== undefined) {
      return invalid('Per-event info is not supported')
    }
    if (channelKind(event.channel) === 'encrypted') {
      return invalid('Encrypted channels are not supported')
    }
    if (dataBytes(event.data) > MAX_DATA_BYTES) {
      return { ok: false, status: 413, error: 'Event data exceeds 10KB' }
    }
    events.push({
      name: event.name,
      channel: event.channel,
      data: event.data,
      socketId: event.socket_id,
    })
  }

  return { ok: true, events }
}

export function parseHistoryQuery(
  limitRaw: string | undefined,
  beforeRaw: string | undefined,
): HistoryQueryParse {
  let limit = DEFAULT_HISTORY_LIMIT
  if (limitRaw !== undefined) {
    const parsed = v.safeParse(historyLimitSchema, limitRaw)
    if (!parsed.success) {
      return { ok: false, error: `limit must be an integer from 1 to ${MAX_HISTORY_LIMIT}` }
    }
    limit = parsed.output
  }

  if (beforeRaw === undefined) {
    return { ok: true, query: { limit, before: undefined } }
  }

  const parsed = v.safeParse(historyBeforeSchema, beforeRaw)
  if (!parsed.success) {
    return { ok: false, error: 'before must be a positive integer' }
  }

  return { ok: true, query: { limit, before: parsed.output } }
}

export function dataBytes(data: unknown): number {
  const text: string | undefined = typeof data === 'string' ? data : JSON.stringify(data)
  return text === undefined ? 0 : encoder.encode(text).length
}

export function parseChannelInfo(raw: string | undefined): ChannelInfoParse {
  const info: ChannelInfoRequest = { userCount: false, subscriptionCount: false, cache: false }

  for (const name of (raw ?? '').split(',')) {
    if (name === '') continue
    const attribute = INFO_ATTRIBUTES.get(name)
    if (attribute === undefined) {
      return { ok: false, error: `Unsupported info attribute: ${name}` }
    }
    info[attribute] = true
  }

  return { ok: true, info }
}

export function channelList(
  snapshot: ChannelSnapshot,
  prefix: string | undefined,
  info: ChannelInfoRequest,
): ChannelListResult {
  if (info.cache) {
    return { ok: false, error: 'cache is only available on a single channel' }
  }

  if (info.userCount && (prefix === undefined || !prefix.startsWith('presence-'))) {
    return {
      ok: false,
      error: 'user_count requires a filter_by_prefix that selects presence channels',
    }
  }

  const channels: Record<string, ChannelAttributes> = {}
  for (const [name, entry] of Object.entries(snapshot)) {
    if (prefix !== undefined && !name.startsWith(prefix)) continue

    const attributes = channelAttributes(channelKind(name), entry, info)
    if (attributes === null) {
      return { ok: false, error: `info does not apply to channel ${name}` }
    }
    channels[name] = attributes
  }

  return { ok: true, body: { channels } }
}

export function channelInfo(
  snapshot: ChannelSnapshot,
  name: string,
  info: ChannelInfoRequest,
): ChannelInfoResult {
  const entry = snapshot[name] ?? { subscriptionCount: 0, userIds: [] }
  const attributes = channelAttributes(channelKind(name), entry, info)
  if (attributes === null) {
    return { ok: false, error: `info does not apply to channel ${name}` }
  }

  return { ok: true, body: { occupied: snapshot[name] !== undefined, ...attributes } }
}

export function channelUsers(snapshot: ChannelSnapshot, name: string): ChannelUsersResult {
  if (channelKind(name) !== 'presence') {
    return { ok: false, error: 'users is only available for presence channels' }
  }

  const entry = snapshot[name]
  return {
    ok: true,
    body: { users: entry === undefined ? [] : entry.userIds.map((id) => ({ id })) },
  }
}

function channelAttributes(
  kind: ChannelKind,
  entry: ChannelSnapshotEntry,
  info: ChannelInfoRequest,
): ChannelAttributes | null {
  const presence = kind === 'presence'
  if (info.userCount && !presence) return null
  if (info.subscriptionCount && presence) return null

  const attributes: ChannelAttributes = {}
  if (info.userCount) attributes.user_count = entry.userIds.length
  if (info.subscriptionCount) attributes.subscription_count = entry.subscriptionCount
  return attributes
}

function invalid(error: string): ParseFailure {
  return { ok: false, status: 400, error }
}
