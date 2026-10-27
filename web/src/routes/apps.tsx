import { getRouteApi } from '@tanstack/react-router'
import { KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { App } from '@/api/contracts'
import { routeIds } from '@/app/paths'
import { AppDialog } from '@/components/apps/app-dialog'
import { DeleteDialog } from '@/components/apps/delete-dialog'
import { RenameDialog } from '@/components/apps/rename-dialog'
import { CopyButton } from '@/components/copy-button'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCreatedAt } from '@/lib/format'
import { useCommand } from '@/lib/use-command'
import { useDocumentTitle } from '@/lib/use-document-title'
import { useOnline } from '@/lib/use-online'

const route = getRouteApi(routeIds.apps)

export function AppsPage() {
  useDocumentTitle('Apps · depush')
  const apps = route.useLoaderData()
  const { api } = route.useRouteContext()
  const online = useOnline()
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<App | null>(null)
  const [deleting, setDeleting] = useState<App | null>(null)
  const create = useCommand(api.apps.create)
  const rename = useCommand(api.apps.rename)
  const remove = useCommand(api.apps.remove)

  const animated = useRef(false)
  useEffect(() => {
    animated.current = true
  }, [])
  const stagger = !animated.current

  function openCreate() {
    create.reset()
    setCreating(true)
  }

  function closeCreate() {
    create.reset()
    setCreating(false)
  }

  function openRename(app: App) {
    rename.reset()
    setRenaming(app)
  }

  function closeRename() {
    rename.reset()
    setRenaming(null)
  }

  function openDelete(app: App) {
    remove.reset()
    setDeleting(app)
  }

  function closeDelete() {
    remove.reset()
    setDeleting(null)
  }

  const offlineTitle = (action: string) =>
    online ? undefined : `Connect to the network to ${action}.`

  return (
    <section>
      <PageHeader
        title="Apps"
        badge={
          <Badge variant="secondary">
            {apps.length} {apps.length === 1 ? 'app' : 'apps'}
          </Badge>
        }
        description="Applications that publish and subscribe through this server."
        action={
          <Button
            type="button"
            onClick={openCreate}
            disabled={!online}
            title={offlineTitle('create an app')}
          >
            <PlusIcon />
            New app
          </Button>
        }
      />

      {apps.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<KeyRoundIcon className="size-5" aria-hidden="true" />}
            title="No apps yet"
            description="Create your first app to get a key and secret."
            action={
              <Button
                type="button"
                onClick={openCreate}
                disabled={!online}
                title={offlineTitle('create an app')}
              >
                <PlusIcon />
                Create app
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="mt-8 space-y-3 md:space-y-0 md:divide-y md:divide-border md:overflow-hidden md:rounded-xl md:border md:border-border">
          {apps.map((app, index) => (
            <li
              key={app.id}
              className="app-row rounded-xl border border-border bg-card p-4 md:rounded-none md:border-0 md:px-5 md:py-4"
              style={stagger ? { animationDelay: `${index * 40}ms` } : undefined}
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-5">
                <div className="min-w-0 md:flex-1">
                  <p className="truncate text-sm font-medium" title={app.name}>
                    {app.name}
                  </p>
                  <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                    Created {formatCreatedAt(app.createdAt)}
                  </p>
                </div>
                <div className="min-w-0 space-y-1 md:w-[24rem]">
                  <ValueRow label="ID" value={app.id} copyLabel="Copy app id" />
                  <ValueRow label="Key" value={app.key} copyLabel="Copy app key" />
                </div>
                <div className="flex items-center gap-1 md:ml-auto">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Rename ${app.name}`}
                    title="Rename app"
                    onClick={() => openRename(app)}
                    disabled={!online}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${app.name}`}
                    title="Delete app"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => openDelete(app)}
                    disabled={!online}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <AppDialog
          open
          online={online}
          state={create.state}
          onCreate={create.execute}
          onClose={closeCreate}
        />
      ) : null}

      {renaming === null ? null : (
        <RenameDialog
          key={renaming.id}
          app={renaming}
          online={online}
          state={rename.state}
          onSubmit={(name) => rename.execute(renaming.id, name)}
          onClose={closeRename}
        />
      )}

      {deleting === null ? null : (
        <DeleteDialog
          key={deleting.id}
          app={deleting}
          state={remove.state}
          onConfirm={() => remove.execute(deleting.id)}
          onClose={closeDelete}
        />
      )}
    </section>
  )
}

export function AppsSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading apps" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="space-y-3 md:space-y-0 md:divide-y md:divide-border md:rounded-xl md:border md:border-border">
        {[0, 1, 2].map((index) => (
          <div
            key={index}
            className="rounded-xl border border-border bg-card p-4 md:rounded-none md:border-0 md:px-5 md:py-4"
          >
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-5">
              <div className="space-y-2 md:flex-1">
                <Skeleton className="h-4 w-40 max-w-full" />
                <Skeleton className="h-3 w-28" />
              </div>
              <div className="space-y-2 md:w-[24rem]">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-11/12" />
              </div>
              <div className="flex gap-1">
                <Skeleton className="size-9 rounded-md" />
                <Skeleton className="size-9 rounded-md" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ValueRow({
  label,
  value,
  copyLabel,
}: {
  label: string
  value: string
  copyLabel: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-7 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        data-copy-value
        title={value}
        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
      >
        {value}
      </span>
      <CopyButton value={value} label={copyLabel} className="-my-1" />
    </div>
  )
}
