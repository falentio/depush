import { getRouteApi, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { routeIds } from '@/app/paths'

const route = getRouteApi(routeIds.forbidden)

export function ForbiddenPage() {
  const { auth, authStore } = route.useRouteContext()
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const email = auth.state === 'anonymous' ? '' : auth.user.email

  async function refreshRole() {
    setPending(true)
    try {
      await authStore.refresh()
      await router.invalidate()
    } finally {
      setPending(false)
    }
  }

  return (
    <section>
      <h1 className="text-xl font-semibold">This account can&apos;t manage apps</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        You&apos;re signed in as {email}, but only an admin can manage apps.
      </p>
      <div className="mt-6 flex gap-3">
        <button type="button" onClick={refreshRole} disabled={pending}>
          Refresh role
        </button>
        <button type="button" onClick={() => void authStore.signOut()}>
          Sign out
        </button>
      </div>
    </section>
  )
}
