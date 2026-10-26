import { vValidator } from '@hono/valibot-validator'
import type { ValidationTargets } from 'hono'
import * as v from 'valibot'
import { errorResponse, validationError } from './errors'

export type ValidationIssue = {
  path: string
  message: string
}

export type ValidationDetails = {
  issues: ValidationIssue[]
}

export const idSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64))

export function issueDetails(issues: readonly v.BaseIssue<unknown>[]): ValidationDetails {
  return {
    issues: issues.map((issue) => ({
      path: v.getDotPath(issue) ?? '',
      message: issue.message,
    })),
  }
}

export function parseId(value: string): string {
  const result = v.safeParse(idSchema, value)
  if (!result.success) throw validationError('Invalid id', issueDetails(result.issues))
  return result.output
}

export function validate<T extends v.GenericSchema, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return vValidator(target, schema, (result) => {
    if (!result.success) {
      return errorResponse(validationError('Invalid request', issueDetails(result.issues)))
    }
  })
}
