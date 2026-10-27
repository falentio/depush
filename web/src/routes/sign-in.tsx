import { getRouteApi, Link } from '@tanstack/react-router'
import { EyeIcon, EyeOffIcon, Loader2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { routeIds, paths } from '@/app/paths'
import { formAuthError } from '@/auth/form-error'
import { useDocumentTitle } from '@/lib/use-document-title'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const route = getRouteApi(routeIds.signIn)

export function SignInPage() {
  const { authStore, auth } = route.useRouteContext()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [visible, setVisible] = useState(false)
  const expired = auth.state === 'anonymous' && auth.reason === 'expired'

  useDocumentTitle('Sign in · depush')

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
    <div className="w-full max-w-sm space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Sign in to depush</CardTitle>
          <CardDescription>
            Manage the apps that publish and subscribe through this server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {expired ? (
            <p
              role="status"
              className="mb-4 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
            >
              Your session expired. Sign in again.
            </p>
          ) : null}
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sign-in-email">Email</Label>
              <Input
                id="sign-in-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                aria-invalid={error !== null}
                aria-describedby={error === null ? undefined : 'sign-in-error'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sign-in-password">Password</Label>
              <div className="relative">
                <Input
                  id="sign-in-password"
                  name="password"
                  type={visible ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  className="pr-10"
                  aria-invalid={error !== null}
                  aria-describedby={error === null ? undefined : 'sign-in-error'}
                />
                <button
                  type="button"
                  aria-label={visible ? 'Hide password' : 'Show password'}
                  title={visible ? 'Hide password' : 'Show password'}
                  aria-pressed={visible}
                  onClick={() => setVisible((current) => !current)}
                  className="absolute inset-y-0 right-0 grid size-9 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-150 ease-[var(--ease-out)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
                >
                  {visible ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>
            {error === null ? null : (
              <p id="sign-in-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? (
                <>
                  <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="text-sm text-muted-foreground">
          <span>
            New here?{' '}
            <Link
              to={paths.signUp}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Create an account
            </Link>
          </span>
        </CardFooter>
      </Card>
      <p className="text-center text-xs text-muted-foreground">
        The first account becomes the admin.
      </p>
    </div>
  )
}
