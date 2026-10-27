import { useRouter } from '@tanstack/react-router'
import { useSyncExternalStore } from 'react'
import type { Auth } from './types'

export function useAuth(): Auth {
  const store = useRouter().options.context.authStore
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
