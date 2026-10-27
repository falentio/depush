import { getRouteApi } from '@tanstack/react-router'
import { routeIds } from '@/app/paths'

const route = getRouteApi(routeIds.settings)

export function SettingsPage() {
  const settings = route.useLoaderData()

  return (
    <section>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-4 text-sm">Sign-ups are {settings.signupEnabled ? 'on' : 'off'}.</p>
    </section>
  )
}
