import { useCallback, useEffect, useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'

export const THEME_STORAGE_KEY = 'depush:theme'

const LIGHT_THEME_COLOR = '#fafafa'
const DARK_THEME_COLOR = '#0b0b0c'

export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function nextTheme(theme: Theme): Theme {
  switch (theme) {
    case 'system':
      return 'light'
    case 'light':
      return 'dark'
    case 'dark':
      return 'system'
  }
}

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): 'light' | 'dark' {
  const resolved = resolveTheme(theme)
  const dark = resolved === 'dark'

  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = resolved
  document.documentElement.dataset.theme = theme

  try {
    if (theme === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
    else localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {}

  const color = dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = color
  }

  return resolved
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const sync = () => applyTheme(theme)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [theme])

  const cycle = useCallback(() => {
    const next = nextTheme(theme)
    setThemeState(next)
    return next
  }, [theme])

  return { theme, cycle }
}
