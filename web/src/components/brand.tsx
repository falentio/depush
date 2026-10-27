import { cn } from '@/lib/utils'

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex select-none items-center gap-2', className)}>
      <img
        src="/icon.svg"
        alt=""
        aria-hidden="true"
        width={28}
        height={28}
        className="size-7 rounded-md"
      />
      <span className="text-sm font-semibold tracking-tight">depush</span>
    </span>
  )
}
