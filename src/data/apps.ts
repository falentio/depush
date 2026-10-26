import * as v from 'valibot'
import type { App } from '../domain/app'
import { appSchema } from '../domain/app'
import { ApiError } from '../http/errors'

const APP_COLUMNS = 'id, name, created_at AS createdAt'

export async function createApp(db: D1Database, input: { name: string }): Promise<App> {
  const row = await db
    .prepare(`INSERT INTO apps (id, name) VALUES (?, ?) RETURNING ${APP_COLUMNS}`)
    .bind(crypto.randomUUID(), input.name)
    .first()

  return v.parse(appSchema, row)
}

export async function listApps(db: D1Database): Promise<App[]> {
  const { results } = await db
    .prepare(`SELECT ${APP_COLUMNS} FROM apps ORDER BY created_at DESC, id DESC`)
    .all()

  return v.parse(v.array(appSchema), results)
}

export async function requireApp(db: D1Database, appId: string): Promise<App> {
  const row = await db.prepare(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`).bind(appId).first()
  if (row === null) throw new ApiError('not_found', `No app with id ${appId}`)

  return v.parse(appSchema, row)
}
