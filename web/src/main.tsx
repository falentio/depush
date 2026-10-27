import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createApp } from '@/app/context'
import { createConsoleRouter } from '@/app/router'
import './styles.css'

const app = createApp()
const router = createConsoleRouter(app)

app.authStore.subscribe(() => {
  void router.invalidate()
})

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Missing #root')

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
