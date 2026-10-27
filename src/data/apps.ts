import { desc, eq } from 'drizzle-orm'
import * as v from 'valibot'
import type { Database } from '../db/client'
import { apps } from '../db/schema'
import type { App } from '../domain/app'
import { appSchema } from '../domain/app'
import { ApiError } from '../http/errors'

export async function createApp(db: Database, input: { name: string }): Promise<App> {
  const [row] = await db
    .insert(apps)
    .values({ id: crypto.randomUUID(), name: input.name })
    .returning()

  return v.parse(appSchema, row)
}

export async function listApps(db: Database): Promise<App[]> {
  const rows = await db.select().from(apps).orderBy(desc(apps.createdAt), desc(apps.id))

  return v.parse(v.array(appSchema), rows)
}

export async function requireApp(db: Database, appId: string): Promise<App> {
  const row = await db.select().from(apps).where(eq(apps.id, appId)).get()
  if (row === undefined) throw new ApiError('not_found', `No app with id ${appId}`)

  return v.parse(appSchema, row)
}
