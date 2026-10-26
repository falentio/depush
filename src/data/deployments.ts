import * as v from 'valibot'
import type { Deployment, DeploymentStatus } from '../domain/deployment'
import { allowedFromStatuses, deploymentSchema, isTransitionAllowed } from '../domain/deployment'
import { ApiError } from '../http/errors'
import type { Cursor } from '../http/pagination'
import { encodeCursor } from '../http/pagination'

const DEPLOYMENT_COLUMNS =
  'id, app_id AS appId, status, commit_sha AS commitSha, created_at AS createdAt, updated_at AS updatedAt'

const deploymentListSchema = v.array(deploymentSchema)

export type NewDeployment = {
  id: string
  commitSha: string
  status: DeploymentStatus
}

export type DeploymentPage = {
  deployments: Deployment[]
  nextCursor: string | null
}

async function findDeployment(db: D1Database, deploymentId: string): Promise<Deployment | null> {
  const row = await db
    .prepare(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = ?`)
    .bind(deploymentId)
    .first()
  if (row === null) return null

  return v.parse(deploymentSchema, row)
}

async function findDeploymentForApp(
  db: D1Database,
  appId: string,
  deploymentId: string,
): Promise<Deployment | null> {
  const row = await db
    .prepare(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = ? AND app_id = ?`)
    .bind(deploymentId, appId)
    .first()
  if (row === null) return null

  return v.parse(deploymentSchema, row)
}

export async function createDeployment(
  db: D1Database,
  appId: string,
  input: NewDeployment,
): Promise<{ deployment: Deployment; created: boolean }> {
  const inserted = await db
    .prepare(
      `INSERT INTO deployments (id, app_id, status, commit_sha) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${DEPLOYMENT_COLUMNS}`,
    )
    .bind(input.id, appId, input.status, input.commitSha)
    .first()

  if (inserted !== null) {
    return { deployment: v.parse(deploymentSchema, inserted), created: true }
  }

  const existing = await findDeployment(db, input.id)
  if (existing === null) throw new ApiError('conflict', `Deployment ${input.id} is unavailable`)
  if (existing.appId !== appId) {
    throw new ApiError('conflict', `Deployment ${input.id} belongs to another app`)
  }

  return { deployment: existing, created: false }
}

export async function transitionDeployment(
  db: D1Database,
  appId: string,
  deploymentId: string,
  status: DeploymentStatus,
): Promise<Deployment> {
  const current = await findDeploymentForApp(db, appId, deploymentId)
  if (current === null) {
    throw new ApiError('not_found', `No deployment ${deploymentId} for app ${appId}`)
  }
  if (!isTransitionAllowed(current.status, status)) {
    throw new ApiError('conflict', `Cannot move a deployment from ${current.status} to ${status}`, {
      from: current.status,
      to: status,
    })
  }

  const allowedFrom = allowedFromStatuses(status)
  const placeholders = allowedFrom.map(() => '?').join(', ')
  const row = await db
    .prepare(
      `UPDATE deployments
       SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND app_id = ? AND status IN (${placeholders})
       RETURNING ${DEPLOYMENT_COLUMNS}`,
    )
    .bind(status, deploymentId, appId, ...allowedFrom)
    .first()

  if (row !== null) return v.parse(deploymentSchema, row)

  const latest = await findDeploymentForApp(db, appId, deploymentId)
  if (latest === null) {
    throw new ApiError('not_found', `No deployment ${deploymentId} for app ${appId}`)
  }
  throw new ApiError('conflict', `Cannot move a deployment from ${latest.status} to ${status}`, {
    from: latest.status,
    to: status,
  })
}

export async function listDeployments(
  db: D1Database,
  appId: string,
  options: { limit: number; cursor: Cursor | null },
): Promise<DeploymentPage> {
  const { limit, cursor } = options
  const statement =
    cursor === null
      ? db
          .prepare(
            `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments
             WHERE app_id = ?
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .bind(appId, limit + 1)
      : db
          .prepare(
            `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments
             WHERE app_id = ? AND (created_at, id) < (?, ?)
             ORDER BY created_at DESC, id DESC
             LIMIT ?`,
          )
          .bind(appId, cursor.createdAt, cursor.id, limit + 1)

  const { results } = await statement.all()
  const rows = v.parse(deploymentListSchema, results)
  const page = rows.slice(0, limit)
  const boundary = page[page.length - 1]
  const nextCursor =
    rows.length > limit && boundary !== undefined
      ? encodeCursor({ createdAt: boundary.createdAt, id: boundary.id })
      : null

  return { deployments: page, nextCursor }
}
