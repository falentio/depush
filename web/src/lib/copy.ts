import { useCallback, useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/** Clipboard API first, a hidden textarea on non-secure origins, never a throw. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the selection-based copy.
  }

  try {
    const field = document.createElement('textarea')
    field.value = value
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    const copied = document.execCommand('copy')
    field.remove()
    return copied
  } catch {
    return false
  }
}

export function selectCopyValue(button: HTMLElement): void {
  const scope = button.parentElement
  if (scope === null) return

  const target = scope.querySelector('[data-copy-value]')
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.focus()
    target.select()
    return
  }
  if (!(target instanceof HTMLElement)) return

  const range = document.createRange()
  range.selectNodeContents(target)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function useCopy(resetAfterMs = 1500) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const copy = useCallback(
    async (value: string, button?: HTMLElement) => {
      if (timer.current !== null) window.clearTimeout(timer.current)
      const copied = await copyText(value)
      setState(copied ? 'copied' : 'failed')
      if (!copied && button !== undefined) selectCopyValue(button)
      timer.current = window.setTimeout(() => setState('idle'), resetAfterMs)
      return copied
    },
    [resetAfterMs],
  )

  return { state, copy }
}
