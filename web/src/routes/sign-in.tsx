import { getRouteApi, Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { routeIds, paths } from '@/app/paths'
import { formAuthError } from '@/auth/form-error'

const route = getRouteApi(routeIds.signIn)

export function SignInPage() {
  const { authStore, auth } = route.useRouteContext()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const expired = auth.state === 'anonymous' && auth.reason === 'expired'

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    setPending(true)
    try {
      await authStore.signIn({
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      })
    } catch (cause) {
      setError(formAuthError(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-semibold">Sign in to depush</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Manage the apps that publish and subscribe through this server.
      </p>
      {expired ? (
        <p role="status" className="mt-4 text-sm">
          Your session expired. Sign in again.
        </p>
      ) : null}
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground active:scale-[0.97] disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        <Link to={paths.signUp} className="underline">
          Create an account
        </Link>
      </p>
      <p className="mt-6 text-xs text-muted-foreground">The first account becomes the admin.</p>
    </div>
  )
}
