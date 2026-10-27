import { Outlet } from '@tanstack/react-router'
import { UpdateBanner } from '@/components/update-banner'

export function RootLayout() {
  return (
    <>
      <Outlet />
      {import.meta.env.PROD ? <UpdateBanner /> : null}
    </>
  )
}
