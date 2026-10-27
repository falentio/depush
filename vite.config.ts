import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { assertRouteNamespace, paths, WORKER_PREFIXES } from './web/src/app/paths.ts'

assertRouteNamespace(Object.values(paths))

export default defineConfig({
  plugins: [
    cloudflare(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      devOptions: { enabled: false },
      manifest: {
        id: '/console',
        name: 'depush console',
        short_name: 'depush',
        description: 'Admin console for a self-hosted depush server',
        start_url: '/console',
        scope: '/console',
        display: 'standalone',
        background_color: '#fafafa',
        theme_color: '#059669',
        lang: 'en',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: WORKER_PREFIXES.map((prefix) => new RegExp(`^${prefix}(?:/|$)`)),
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url).href),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
