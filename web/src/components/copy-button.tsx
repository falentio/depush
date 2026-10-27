import { CheckIcon, CopyIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { useCopy } from '@/lib/copy'
import { cn } from '@/lib/utils'

export function CopyButton({
  value,
  label,
  variant,
  size,
  className,
  children,
}: {
  value: string
  label: string
  variant?: 'ghost' | 'outline' | 'secondary'
  size?: 'sm' | 'icon'
  className?: string
  children?: ReactNode
}) {
  const { state, copy } = useCopy()
  const icon =
    state === 'copied' ? (
      <CheckIcon className="text-primary" />
    ) : (
      <CopyIcon className="text-muted-foreground" />
    )

  return (
    <Button
      type="button"
      variant={variant ?? (children === undefined ? 'ghost' : 'outline')}
      size={size ?? (children === undefined ? 'icon' : 'sm')}
      className={cn(children === undefined && 'text-muted-foreground', className)}
      aria-label={label}
      title={label}
      onClick={(event) => {
        void copy(value, event.currentTarget)
      }}
    >
      {icon}
      {children}
      <span className="sr-only" aria-live="polite">
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Copy failed. The value is selected for manual copying.'
            : ''}
      </span>
    </Button>
  )
}
