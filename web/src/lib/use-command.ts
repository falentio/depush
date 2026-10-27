import { useRouter } from '@tanstack/react-router'
import { useCallback, useRef, useState } from 'react'
import { type ApiError, toApiError } from '@/api/errors'

export type CommandState<T> =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'failed'; error: ApiError }
  | { status: 'succeeded'; value: T }

export function useCommand<A extends unknown[], T>(command: (...args: A) => Promise<T>) {
  const router = useRouter()
  const [state, setState] = useState<CommandState<T>>({ status: 'idle' })
  const pending = useRef(false)

  const execute = useCallback(
    async (...args: A): Promise<boolean> => {
      if (pending.current) return false
      pending.current = true
      setState({ status: 'pending' })

      try {
        const value = await command(...args)
        setState({ status: 'succeeded', value })
        try {
          await router.invalidate()
        } catch {
          // A failed refresh must not replace a value the server will not send
          // again, such as a new app's secret.
        }
        return true
      } catch (error) {
        setState({ status: 'failed', error: toApiError(error) })
        return false
      } finally {
        pending.current = false
      }
    },
    [command, router],
  )

  const reset = useCallback(() => {
    if (pending.current) return
    setState({ status: 'idle' })
  }, [])

  return { state, execute, reset }
}
