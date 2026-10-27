import { useRouter } from '@tanstack/react-router'
import { Loader2Icon, ShieldXIcon } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/auth/use-auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useDocumentTitle } from '@/lib/use-document-title'

export function ForbiddenPage() {
  useDocumentTitle('Access denied · depush')
  const auth = useAuth()
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const email = auth.state === 'admin' || auth.state === 'user' ? auth.user.email : ''

  async function refreshRole() {
    setRefreshing(true)
    setError(null)
    try {
      const next = await router.options.context.authStore.refresh()
      await router.invalidate()
      if (next.state === 'unavailable') {
        setError('Could not refresh the role. Try again.')
      }
    } catch {
      setError('Could not refresh the role. Try again.')
    } finally {
      setRefreshing(false)
    }
  }

  async function signOut() {
    setError(null)
    try {
      await router.options.context.authStore.signOut()
    } catch {
      setError('Could not sign out. Try again.')
    }
  }

  return (
    <div className="mx-auto mt-8 w-full max-w-lg sm:mt-16">
      <Card>
        <CardContent className="flex flex-col items-center text-center">
          <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
            <ShieldXIcon className="size-5" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-lg font-semibold">This account can&apos;t manage apps</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            You&apos;re signed in as <span className="font-medium text-foreground">{email}</span>,
            but only an admin can manage apps.
          </p>
          <Badge variant="secondary" className="mt-4">
            {auth.state === 'admin' ? 'Admin' : 'User'}
          </Badge>
          {error === null ? null : (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-6 flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-center">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void signOut()
              }}
            >
              Sign out
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={refreshing}
              onClick={() => {
                void refreshRole()
              }}
            >
              {refreshing ? (
                <>
                  <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                  Refreshing…
                </>
              ) : (
                'Refresh role'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
