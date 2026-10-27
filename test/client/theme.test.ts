import { describe, expect, it } from 'vitest'
import { nextTheme } from '@/lib/theme'

describe('nextTheme', () => {
  it.each([
    ['system', 'light'],
    ['light', 'dark'],
    ['dark', 'system'],
  ] as const)('cycles %s to %s', (theme, next) => {
    expect(nextTheme(theme)).toBe(next)
  })
})
