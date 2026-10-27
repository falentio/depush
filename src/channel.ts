import { DurableObject } from 'cloudflare:workers'
import type { AppBindings } from './env'
import type { HistoryEvent, HistoryPage, HistoryQuery } from './events'

export type CachedEvent = { name: string; data: string }
export type CachedEventInfo = { data: string; ttl: number }

export type ChannelEventInput = {
  name: string
  data: string
  userId: string | null
  cache: boolean
  ttlSeconds: number
}

export const HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000
export const HISTORY_MAX_EVENTS = 1000

type CacheRow = {
  event_name: string
  data: string
  expires_at: number
}

type EventRow = {
  id: number
  name: string
  data: string
  user_id: string | null
  published_at: number
}

const CREATE_CACHE_TABLE = `
CREATE TABLE IF NOT EXISTS cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_name TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)
`

const CREATE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  user_id TEXT,
  published_at INTEGER NOT NULL
)
`

export class Channel extends DurableObject<AppBindings> {
  constructor(ctx: DurableObjectState, env: AppBindings) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(CREATE_CACHE_TABLE)
      ctx.storage.sql.exec(CREATE_EVENTS_TABLE)
    })
  }

  async record(input: ChannelEventInput): Promise<void> {
    const now = Date.now()
    this.ctx.storage.sql.exec(
      'INSERT INTO events (name, data, user_id, published_at) VALUES (?, ?, ?, ?)',
      input.name,
      input.data,
      input.userId,
      now,
    )
    this.prune(now)

    if (!input.cache) return

    this.ctx.storage.sql.exec(
      `INSERT INTO cache (id, event_name, data, expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET event_name = excluded.event_name, data = excluded.data, expires_at = excluded.expires_at`,
      input.name,
      input.data,
      now + input.ttlSeconds * 1000,
    )
  }

  async history(input: HistoryQuery): Promise<HistoryPage> {
    const rows = this.ctx.storage.sql
      .exec<EventRow>(
        'SELECT id, name, data, user_id, published_at FROM events WHERE id < ? ORDER BY id DESC LIMIT ?',
        input.before ?? Number.MAX_SAFE_INTEGER,
        input.limit + 1,
      )
      .toArray()

    const page = rows.slice(0, input.limit)
    const oldest = page.at(-1)
    return {
      events: page.map(historyEvent),
      next_cursor: rows.length > input.limit && oldest !== undefined ? String(oldest.id) : null,
    }
  }

  async snapshot(): Promise<CachedEvent | null> {
    const row = this.cachedRow()
    return row === null ? null : { name: row.event_name, data: row.data }
  }

  async cacheInfo(): Promise<CachedEventInfo | null> {
    const row = this.cachedRow()
    if (row === null) return null

    return {
      data: row.data,
      ttl: Math.max(0, Math.floor((row.expires_at - Date.now()) / 1000)),
    }
  }

  private prune(now: number): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM events WHERE published_at < ?',
      now - HISTORY_RETENTION_MS,
    )
    this.ctx.storage.sql.exec(
      'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?)',
      HISTORY_MAX_EVENTS,
    )
  }

  private cachedRow(): CacheRow | null {
    const row = this.ctx.storage.sql
      .exec<CacheRow>('SELECT event_name, data, expires_at FROM cache WHERE id = 1')
      .toArray()[0]
    if (row === undefined) return null

    if (row.expires_at <= Date.now()) {
      this.ctx.storage.sql.exec('DELETE FROM cache WHERE id = 1')
      return null
    }

    return row
  }
}

function historyEvent(row: EventRow): HistoryEvent {
  const event: HistoryEvent = {
    id: row.id,
    name: row.name,
    data: row.data,
    published_at: new Date(row.published_at).toISOString(),
  }
  if (row.user_id !== null) event.user_id = row.user_id
  return event
}
