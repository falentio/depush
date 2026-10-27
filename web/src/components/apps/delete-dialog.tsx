import { Loader2Icon } from 'lucide-react'
import type { App } from '@/api/contracts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import type { CommandState } from '@/lib/use-command'

export function DeleteDialog({
  app,
  state,
  onConfirm,
  onClose,
}: {
  app: App
  state: CommandState<void>
  onConfirm: () => Promise<boolean>
  onClose: () => void
}) {
  const pending = state.status === 'pending'

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose()
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete <span className="font-semibold">{app.name}</span>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This removes the app and its keys. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {state.status === 'failed' ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error.message}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: 'destructive' })}
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              void onConfirm().then((deleted) => {
                if (deleted) onClose()
              })
            }}
          >
            {pending ? (
              <>
                <Loader2Icon className="animate-spin motion-reduce:animate-none" />
                Deleting…
              </>
            ) : (
              'Delete app'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
