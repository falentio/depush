import { describe, expect, it } from 'vitest'
import { DEFAULT_CACHE_TTL_SECONDS, readConfig } from '../src/config'

const credentials = {
  PUSHER_APP_ID: '1',
  PUSHER_APP_KEY: 'key',
  PUSHER_APP_SECRET: 'secret',
}

function cacheTtl(raw: string | undefined): number {
  return readConfig({ ...credentials, PUSHER_CACHE_TTL_SECONDS: raw }).cacheTtlSeconds
}

describe('readConfig cache TTL', () => {
  it('defaults to 1800 seconds', () => {
    expect(DEFAULT_CACHE_TTL_SECONDS).toBe(1800)
    expect(cacheTtl(undefined)).toBe(1800)
  })

  it('accepts a value up to the ceiling', () => {
    expect(cacheTtl('2')).toBe(2)
    expect(cacheTtl('1800')).toBe(1800)
  })

  it('falls back to 1800 for zero, non-numeric, and fractional values', () => {
    expect(cacheTtl('0')).toBe(1800)
    expect(cacheTtl('nope')).toBe(1800)
    expect(cacheTtl('2.5')).toBe(1800)
  })

  it('clamps a value above the 30-minute ceiling', () => {
    expect(cacheTtl('1801')).toBe(1800)
    expect(cacheTtl('999999')).toBe(1800)
  })
})
