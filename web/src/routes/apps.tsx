import { getRouteApi } from '@tanstack/react-router'
import { routeIds } from '@/app/paths'

const route = getRouteApi(routeIds.apps)

export function AppsPage() {
  const apps = route.useLoaderData()

  return (
    <section>
      <h1 className="text-2xl font-semibold">Apps</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Applications that publish and subscribe through this server.
      </p>
      {apps.length === 0 ? (
        <p className="mt-8 text-sm text-muted-foreground">No apps yet</p>
      ) : (
        <ul className="mt-8 divide-y divide-border rounded-xl border border-border">
          {apps.map((app) => (
            <li key={app.id} className="p-4">
              <p className="font-medium">{app.name}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{app.id}</p>
              <p className="font-mono text-xs text-muted-foreground">{app.key}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
