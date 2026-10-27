import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { nextTheme, useTheme } from '@/lib/theme'

export function ThemeToggle() {
  const { theme, cycle } = useTheme()
  const next = nextTheme(theme)
  const Icon = theme === 'system' ? MonitorIcon : theme === 'light' ? SunIcon : MoonIcon
  const label = `Theme: ${theme}. Switch to ${next}.`

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      title={label}
      onClick={cycle}
    >
      <Icon />
    </Button>
  )
}
