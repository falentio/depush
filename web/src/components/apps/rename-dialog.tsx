import { Loader2Icon } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import type { App } from '@/api/contracts'
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

export function RenameDialog({
  app,
  online,
  state,
  onSubmit,
  onClose,
}: {
  app: App
  online: boolean
  state: CommandState<App>
  onSubmit: (name: string) => Promise<boolean>
  onClose: () => void
}) {
  const [name, setName] = useState(app.name)
  const pending = state.status === 'pending'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 100) return
    const saved = await onSubmit(trimmed)
    if (saved) onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose()
      }}
    >
      <DialogContent
        showClose={!pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename app</DialogTitle>
          <DialogDescription>
            The id, key, and secret stay the same. Only the display name changes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="rename-app-name">Name</Label>
            <Input
              id="rename-app-name"
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
              title={online ? undefined : 'Connect to the network to rename an app.'}
            >
              {pending ? (
                <>
                  <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                  Saving…
                </>
              ) : (
                'Save name'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
