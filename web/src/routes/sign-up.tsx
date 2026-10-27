import { getRouteApi, Link } from '@tanstack/react-router'
import { EyeIcon, EyeOffIcon, Loader2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { isApiError } from '@/api/errors'
import { paths, routeIds } from '@/app/paths'
import { formAuthError } from '@/auth/form-error'
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
import { useDocumentTitle } from '@/lib/use-document-title'

const route = getRouteApi(routeIds.signUp)

type SignUpError = { message: string; showSignIn: boolean }

export function SignUpPage() {
  const { authStore } = route.useRouteContext()
  const [error, setError] = useState<SignUpError | null>(null)
  const [invalidField, setInvalidField] = useState<'email' | null>(null)
  const [pending, setPending] = useState(false)
  const [visible, setVisible] = useState(false)

  useDocumentTitle('Create an account · depush')

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    setInvalidField(null)
    setPending(true)
    try {
      await authStore.signUp({
        name: String(form.get('name') ?? ''),
        email: String(form.get('email') ?? ''),
        password: String(form.get('password') ?? ''),
      })
    } catch (cause) {
      const showSignIn = isApiError(cause) && cause.status === 403
      setInvalidField(isApiError(cause) && cause.status === 422 ? 'email' : null)
      setError({
        message: formAuthError(cause, { duplicateEmail: true }),
        showSignIn,
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="w-full max-w-sm">
      <Card>
        <CardHeader>
          <CardTitle as="h1" className="text-xl">
            Create an account
          </CardTitle>
          <CardDescription>
            The first account becomes the admin. Later accounts can sign in but cannot manage apps.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sign-up-name">Name</Label>
              <Input id="sign-up-name" name="name" autoComplete="name" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sign-up-email">Email</Label>
              <Input
                id="sign-up-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                aria-invalid={invalidField === 'email'}
                aria-describedby={invalidField === 'email' ? 'sign-up-error' : undefined}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sign-up-password">Password</Label>
              <div className="relative">
                <Input
                  id="sign-up-password"
                  name="password"
                  type={visible ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  className="pr-10"
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
              <p id="sign-up-error" role="alert" className="text-sm text-destructive">
                {error.message}
                {error.showSignIn ? (
                  <>
                    {' '}
                    <Link
                      to={paths.signIn}
                      search={{ redirect: paths.apps }}
                      className="underline underline-offset-4"
                    >
                      Sign in instead
                    </Link>
                  </>
                ) : null}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? (
                <>
                  <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                  Creating account…
                </>
              ) : (
                'Create account'
              )}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="text-sm text-muted-foreground">
          <span>
            Already have an account?{' '}
            <Link
              to={paths.signIn}
              search={{ redirect: paths.apps }}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Sign in
            </Link>
          </span>
        </CardFooter>
      </Card>
    </div>
  )
}
