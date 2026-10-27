import { getRouteApi } from '@tanstack/react-router'
import { CheckIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { routeIds } from '@/app/paths'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useCommand } from '@/lib/use-command'
import { useDocumentTitle } from '@/lib/use-document-title'
import { useOnline } from '@/lib/use-online'

const route = getRouteApi(routeIds.settings)

export function SettingsPage() {
  useDocumentTitle('Settings · depush')
  const settings = route.useLoaderData()
  const { api } = route.useRouteContext()
  const online = useOnline()
  const write = useCommand(api.settings.write)
  const [checked, setChecked] = useState(settings.signupEnabled)
  const [saved, setSaved] = useState(false)
  const pending = write.state.status === 'pending'

  useEffect(() => {
    setChecked(settings.signupEnabled)
  }, [settings.signupEnabled])

  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 2000)
    return () => window.clearTimeout(timer)
  }, [saved])

  async function toggle(next: boolean) {
    if (pending) return
    setChecked(next)
    setSaved(false)
    const succeeded = await write.execute(next)
    if (!succeeded) {
      setChecked(settings.signupEnabled)
      return
    }
    setSaved(true)
  }

  return (
    <section>
      <PageHeader
        title="Settings"
        description="Server-wide configuration for this depush deployment."
      />
      <Card className="mt-8 max-w-2xl">
        <CardHeader>
          <CardTitle>Sign-ups</CardTitle>
          <CardDescription>
            Allow new accounts to sign up. Only the first account is an admin; later accounts can
            sign in but cannot manage apps.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="signup-enabled" className="font-normal">
              Allow new sign-ups
            </Label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {pending ? (
                  'Saving…'
                ) : saved ? (
                  <span className="inline-flex items-center gap-1 text-primary">
                    <CheckIcon className="size-3.5" aria-hidden="true" />
                    Saved
                  </span>
                ) : (
                  ''
                )}
              </span>
              <Switch
                id="signup-enabled"
                checked={checked}
                onCheckedChange={(next) => {
                  void toggle(next)
                }}
                disabled={pending || !online}
                title={online ? undefined : 'Connect to the network to change sign-up settings.'}
              />
            </div>
          </div>
          {write.state.status === 'failed' ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {write.state.error.message}
            </p>
          ) : null}
          <p className="mt-4 text-xs text-muted-foreground">
            The first account can always be created, even when sign-ups are off.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}
