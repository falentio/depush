import { describe, expect, it } from 'vitest'
import { appConfig, DEFAULT_CACHE_TTL_SECONDS, readSettings } from '../src/config'

function cacheTtl(raw: string | undefined): number {
  return readSettings({ PUSHER_CACHE_TTL_SECONDS: raw }).cacheTtlSeconds
}

function activityTimeout(raw: string | undefined): number {
  return readSettings({ PUSHER_ACTIVITY_TIMEOUT: raw }).activityTimeout
}

describe('readSettings cache TTL', () => {
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

describe('readSettings activity timeout', () => {
  it('defaults to 120 seconds and keeps positive integers', () => {
    expect(activityTimeout(undefined)).toBe(120)
    expect(activityTimeout('1')).toBe(1)
    expect(activityTimeout('300')).toBe(300)
  })

  it('falls back to 120 for unusable values', () => {
    expect(activityTimeout('0')).toBe(120)
    expect(activityTimeout('-5')).toBe(120)
    expect(activityTimeout('abc')).toBe(120)
  })
})

describe('appConfig', () => {
  it('takes credentials from the app row and timeouts from the settings', () => {
    expect(
      appConfig(
        { id: 'app12345', key: 'k'.repeat(32), secret: 's'.repeat(32) },
        { activityTimeout: 30, cacheTtlSeconds: 60 },
      ),
    ).toEqual({
      appId: 'app12345',
      key: 'k'.repeat(32),
      secret: 's'.repeat(32),
      activityTimeout: 30,
      cacheTtlSeconds: 60,
    })
  })
})
