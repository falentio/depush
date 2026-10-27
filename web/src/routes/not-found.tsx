import { Link } from '@tanstack/react-router'
import { paths } from '@/app/paths'
import { useAuth } from '@/auth/use-auth'

export function NotFoundPage() {
  const auth = useAuth()
  const anonymous = auth.state === 'anonymous'

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="text-center">
        <h1 className="text-xl font-semibold">That page doesn&apos;t exist.</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {anonymous ? (
            <Link to={paths.signIn} search={{ redirect: paths.apps }} className="underline">
              Go to sign in
            </Link>
          ) : (
            <Link to={paths.apps} className="underline">
              Go to apps
            </Link>
          )}
        </p>
      </div>
    </main>
  )
}
