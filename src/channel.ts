import { DurableObject } from 'cloudflare:workers'
import type { AppBindings } from './env'

export type CachedEvent = { name: string; data: string }
export type CachedEventInfo = { data: string; ttl: number }

export type ChannelEventInput = {
  name: string
  data: string
  userId: string | null
  cache: boolean
  ttlSeconds: number
}

type CacheRow = {
  event_name: string
  data: string
  expires_at: number
}

const CREATE_CACHE_TABLE = `
CREATE TABLE IF NOT EXISTS cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_name TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)
`

export class Channel extends DurableObject<AppBindings> {
  constructor(ctx: DurableObjectState, env: AppBindings) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(CREATE_CACHE_TABLE)
    })
  }

  async record(input: ChannelEventInput): Promise<void> {
    if (!input.cache) return

    this.ctx.storage.sql.exec(
      `INSERT INTO cache (id, event_name, data, expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET event_name = excluded.event_name, data = excluded.data, expires_at = excluded.expires_at`,
      input.name,
      input.data,
      Date.now() + input.ttlSeconds * 1000,
    )
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
