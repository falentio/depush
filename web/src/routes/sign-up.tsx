import { getRouteApi, Link } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { routeIds, paths } from '@/app/paths'
import { formAuthError } from '@/auth/form-error'

const route = getRouteApi(routeIds.signUp)

export function SignUpPage() {
  const { authStore } = route.useRouteContext()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    setPending(true)
    try {
      await authStore.signUp({
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      })
    } catch (cause) {
      setError(formAuthError(cause, { duplicateEmail: true }))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="text-2xl font-semibold">Create an account</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The first account becomes the admin. Later accounts can sign in but cannot manage apps.
      </p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block text-sm">
          Name
          <input
            name="name"
            autoComplete="name"
            required
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
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
            autoComplete="new-password"
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
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link to={paths.signIn} search={{ redirect: paths.apps }} className="underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
