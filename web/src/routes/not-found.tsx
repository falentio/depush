import { Link } from '@tanstack/react-router'
import { SearchXIcon } from 'lucide-react'
import { paths } from '@/app/paths'
import { useAuth } from '@/auth/use-auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useDocumentTitle } from '@/lib/use-document-title'

export function NotFoundPage() {
  useDocumentTitle('Page not found · depush')
  const auth = useAuth()
  const anonymous = auth.state === 'anonymous'

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center text-center">
          <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
            <SearchXIcon className="size-5" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-lg font-semibold">That page doesn&apos;t exist.</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The address may be mistyped, or the page may have moved.
          </p>
          <Button asChild className="mt-6">
            {anonymous ? (
              <Link to={paths.signIn} search={{ redirect: paths.apps }}>
                Go to sign in
              </Link>
            ) : (
              <Link to={paths.apps}>Go to apps</Link>
            )}
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
