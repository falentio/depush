import { useRouter } from '@tanstack/react-router'
import { useCallback, useSyncExternalStore } from 'react'
import type { Auth } from './types'

export function useAuth(): Auth {
  const store = useRouter().options.context.authStore
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

export function useAuthActions() {
  const router = useRouter()
  const store = router.options.context.authStore

  const refresh = useCallback(async () => {
    const next = await store.refresh()
    await router.invalidate()
    return next
  }, [router, store])

  const signOut = useCallback(async () => {
    await store.signOut()
    await router.invalidate()
  }, [router, store])

  return { refresh, signOut }
}
