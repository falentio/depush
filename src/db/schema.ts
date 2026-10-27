import { sql } from 'drizzle-orm'
import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { DeploymentStatus } from '../domain/deployment'
import { DEPLOYMENT_STATUSES } from '../domain/deployment'

const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

const allowedStatuses = sql.raw(
  `(${DEPLOYMENT_STATUSES.map((status) => `'${status}'`).join(', ')})`,
)

export const apps = sqliteTable('apps', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull().default(now()),
})

export const deployments = sqliteTable(
  'deployments',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    status: text('status').$type<DeploymentStatus>().notNull(),
    commitSha: text('commit_sha').notNull(),
    createdAt: text('created_at').notNull().default(now()),
    updatedAt: text('updated_at').notNull().default(now()),
  },
  (table) => [
    index('deployments_by_app').on(table.appId, table.createdAt, table.id),
    check('deployments_status_check', sql`${table.status} in ${allowedStatuses}`),
  ],
)

export type AppRow = typeof apps.$inferSelect
export type DeploymentRow = typeof deployments.$inferSelect
