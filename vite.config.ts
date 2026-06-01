import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Base path. On GitHub Pages a project site is served from /<repo>/, so the CI
// workflow passes VITE_BASE=/<repo>/. Locally (dev/preview/tests) it stays '/'.
const base = process.env.VITE_BASE || '/'

// https://vitejs.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // foliate-js lives in /public and is loaded as raw ES modules at runtime.
      includeAssets: ['icons/*', 'foliate-js/**/*'],
      manifest: {
        name: '阅读器',
        short_name: '阅读器',
        description: '一个把想法记在划线当下的 EPUB 阅读器',
        lang: 'zh-CN',
        theme_color: '#faf9f7',
        background_color: '#faf9f7',
        display: 'standalone',
        orientation: 'portrait',
        // scope/start_url must respect the base so the PWA installs correctly
        // under a subpath. Relative icon src resolves against the manifest URL.
        scope: base,
        start_url: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell + all foliate-js modules + book assets get precached so the
        // app (and already-imported books, whose data is in IndexedDB) work offline.
        globPatterns: ['**/*.{js,css,html,svg,png,json,woff2}'],
        // foliate-js can be large; raise the limit so its vendor bundles precache.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: base + 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
})
