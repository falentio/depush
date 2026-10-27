import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import * as v from 'valibot'
import type { Database } from '../db/client'
import { deployments } from '../db/schema'
import type { Deployment, DeploymentStatus } from '../domain/deployment'
import { allowedFromStatuses, deploymentSchema, isTransitionAllowed } from '../domain/deployment'
import { ApiError } from '../http/errors'
import type { Cursor } from '../http/pagination'
import { encodeCursor } from '../http/pagination'

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

async function findDeployment(db: Database, deploymentId: string): Promise<Deployment | null> {
  const row = await db.select().from(deployments).where(eq(deployments.id, deploymentId)).get()
  if (row === undefined) return null

  return v.parse(deploymentSchema, row)
}

async function findDeploymentForApp(
  db: Database,
  appId: string,
  deploymentId: string,
): Promise<Deployment | null> {
  const row = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.id, deploymentId), eq(deployments.appId, appId)))
    .get()
  if (row === undefined) return null

  return v.parse(deploymentSchema, row)
}

export async function createDeployment(
  db: Database,
  appId: string,
  input: NewDeployment,
): Promise<{ deployment: Deployment; created: boolean }> {
  const [inserted] = await db
    .insert(deployments)
    .values({ id: input.id, appId, status: input.status, commitSha: input.commitSha })
    .onConflictDoNothing()
    .returning()

  if (inserted !== undefined) {
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
  db: Database,
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
  const [row] = await db
    .update(deployments)
    .set({ status, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` })
    .where(
      and(
        eq(deployments.id, deploymentId),
        eq(deployments.appId, appId),
        inArray(deployments.status, allowedFrom),
      ),
    )
    .returning()

  if (row !== undefined) return v.parse(deploymentSchema, row)

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
  db: Database,
  appId: string,
  options: { limit: number; cursor: Cursor | null },
): Promise<DeploymentPage> {
  const { limit, cursor } = options
  const conditions = [eq(deployments.appId, appId)]
  if (cursor !== null) {
    conditions.push(
      sql`(${deployments.createdAt}, ${deployments.id}) < (${cursor.createdAt}, ${cursor.id})`,
    )
  }

  const rows = await db
    .select()
    .from(deployments)
    .where(and(...conditions))
    .orderBy(desc(deployments.createdAt), desc(deployments.id))
    .limit(limit + 1)

  const parsed = v.parse(deploymentListSchema, rows)
  const page = parsed.slice(0, limit)
  const boundary = page[page.length - 1]
  const nextCursor =
    parsed.length > limit && boundary !== undefined
      ? encodeCursor({ createdAt: boundary.createdAt, id: boundary.id })
      : null

  return { deployments: page, nextCursor }
}
