import { AlertTriangleIcon, Loader2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import type { IssuedApp } from '@/api/contracts'
import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CommandState } from '@/lib/use-command'

export function AppDialog({
  open,
  online,
  state,
  onCreate,
  onClose,
}: {
  open: boolean
  online: boolean
  state: CommandState<IssuedApp>
  onCreate: (name: string) => Promise<boolean>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const pending = state.status === 'pending'
  const issued = state.status === 'succeeded'
  const locked = pending || issued

  function handleOpenChange(next: boolean) {
    if (next) return
    if (locked) return
    onClose()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 100) return
    await onCreate(trimmed)
  }

  const issuedApp = state.status === 'succeeded' ? state.value : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showClose={!locked}
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (locked) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{issued ? 'App created' : 'New app'}</DialogTitle>
          <DialogDescription>
            {issued
              ? 'Store the credentials before you close this dialog.'
              : "Name the app. You'll get its key and secret next."}
          </DialogDescription>
        </DialogHeader>

        {issuedApp === null ? (
          <form key="form" onSubmit={submit} className="dialog-step space-y-4">
            <div className="space-y-2">
              <Label htmlFor="app-name">Name</Label>
              <Input
                id="app-name"
                name="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                autoFocus
                required
              />
              <p className="text-xs text-muted-foreground">1-100 characters.</p>
            </div>
            {state.status === 'failed' ? (
              <p role="alert" className="text-sm text-destructive">
                {state.error.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={pending || !online || name.trim().length === 0}
                title={online ? undefined : 'Connect to the network to create an app.'}
              >
                {pending ? (
                  <>
                    <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                    Creating…
                  </>
                ) : (
                  'Create app'
                )}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div key="issued" className="dialog-step space-y-4">
            <p className="sr-only" aria-live="polite">
              The app was created. Copy its id, key, and secret now; the secret is shown once.
            </p>
            <Alert>
              <AlertTriangleIcon className="text-amber-600 dark:text-amber-500" />
              <AlertTitle>This secret is shown once.</AlertTitle>
              <AlertDescription>Copy it before you close this dialog.</AlertDescription>
            </Alert>
            <div className="space-y-3">
              <IssuedValue label="ID" value={issuedApp.id} />
              <IssuedValue label="Key" value={issuedApp.key} />
              <IssuedValue label="Secret" value={issuedApp.secret} />
            </div>
            <CopyButton
              value={envBlock(issuedApp)}
              label="Copy the .env block"
              variant="outline"
              size="sm"
            >
              Copy .env
            </CopyButton>
            <DialogFooter>
              <Button type="button" className="w-full sm:w-auto" onClick={onClose}>
                I&apos;ve saved it
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function IssuedValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
        <span
          data-copy-value
          title={value}
          className="min-w-0 flex-1 whitespace-pre-wrap break-all pt-0.5 font-mono text-xs"
        >
          {value}
        </span>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  )
}

function envBlock(app: IssuedApp): string {
  return [
    `DEPUSH_APP_ID=${app.id}`,
    `DEPUSH_APP_KEY=${app.key}`,
    `DEPUSH_APP_SECRET=${app.secret}`,
    '',
  ].join('\n')
}
