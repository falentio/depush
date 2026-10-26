import { describe, expect, it } from 'vitest'
import type { DeploymentStatus } from '../src/domain/deployment'
import {
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRANSITIONS,
  isTransitionAllowed,
} from '../src/domain/deployment'
import { ApiError } from '../src/http/errors'
import { decodeCursor, encodeCursor } from '../src/http/pagination'

const LEGAL_TRANSITIONS: readonly (readonly [DeploymentStatus, DeploymentStatus])[] = [
  ['queued', 'building'],
  ['queued', 'failed'],
  ['building', 'ready'],
  ['building', 'failed'],
]

function catchApiError(run: () => void): ApiError {
  try {
    run()
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('Expected the call to throw an ApiError')
}

describe('deployment transitions', () => {
  it('has a table entry for every status', () => {
    expect(Object.keys(DEPLOYMENT_TRANSITIONS).sort()).toEqual([...DEPLOYMENT_STATUSES].sort())
  })

  it('accepts every legal transition', () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      expect(isTransitionAllowed(from, to), `${from} -> ${to}`).toBe(true)
    }
  })

  it('rejects every transition out of a terminal status', () => {
    for (const to of DEPLOYMENT_STATUSES) {
      expect(isTransitionAllowed('ready', to), `ready -> ${to}`).toBe(false)
      expect(isTransitionAllowed('failed', to), `failed -> ${to}`).toBe(false)
    }
  })

  it('rejects transitions that skip or reverse a state', () => {
    expect(isTransitionAllowed('queued', 'ready')).toBe(false)
    expect(isTransitionAllowed('building', 'queued')).toBe(false)
    expect(isTransitionAllowed('queued', 'queued')).toBe(false)
  })
})

describe('cursor', () => {
  const cursor = { createdAt: '2026-01-02T03:04:05.678Z', id: 'deploy-1' }

  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('rejects a malformed cursor with a validation error', () => {
    expect(catchApiError(() => decodeCursor('not-a-cursor')).code).toBe('validation')
    expect(catchApiError(() => decodeCursor('')).code).toBe('validation')
  })

  it('rejects a cursor with the wrong shape', () => {
    const encoded = btoa(JSON.stringify({ id: 'deploy-1' }))
    expect(catchApiError(() => decodeCursor(encoded)).code).toBe('validation')
  })
})
