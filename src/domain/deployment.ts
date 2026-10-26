import * as v from 'valibot'

export const DEPLOYMENT_STATUSES = ['queued', 'building', 'ready', 'failed'] as const

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number]

export const deploymentStatusSchema = v.picklist(DEPLOYMENT_STATUSES)

export const DEPLOYMENT_TRANSITIONS = {
  queued: ['building', 'failed'],
  building: ['ready', 'failed'],
  ready: [],
  failed: [],
} satisfies Record<DeploymentStatus, readonly DeploymentStatus[]>

export function isTransitionAllowed(from: DeploymentStatus, to: DeploymentStatus): boolean {
  const allowed: readonly DeploymentStatus[] = DEPLOYMENT_TRANSITIONS[from]
  return allowed.includes(to)
}

export function allowedFromStatuses(to: DeploymentStatus): DeploymentStatus[] {
  return DEPLOYMENT_STATUSES.filter((status) => isTransitionAllowed(status, to))
}

export const commitShaSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/i))

export const deploymentSchema = v.object({
  id: v.string(),
  appId: v.string(),
  status: deploymentStatusSchema,
  commitSha: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
})

export type Deployment = v.InferOutput<typeof deploymentSchema>

export const createDeploymentSchema = v.object({
  commitSha: commitShaSchema,
  status: v.optional(deploymentStatusSchema, 'queued'),
  id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
})

export const transitionDeploymentSchema = v.object({
  status: deploymentStatusSchema,
})

export const deploymentEventSchema = v.object({
  id: v.string(),
  status: deploymentStatusSchema,
  commitSha: v.string(),
  at: v.string(),
})

export type DeploymentEvent = v.InferOutput<typeof deploymentEventSchema>

export function toDeploymentEvent(deployment: Deployment): DeploymentEvent {
  return {
    id: deployment.id,
    status: deployment.status,
    commitSha: deployment.commitSha,
    at: deployment.updatedAt,
  }
}
