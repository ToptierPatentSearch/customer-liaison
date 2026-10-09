import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-development-csp',
      apply: 'serve',
      // The enforced production policy remains in index.html and every build.
      // Vite's local dev server needs its inline React preamble, injected CSS,
      // and hot-reload WebSocket. Never weaken the deployed policy for those.
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/>/, ''),
      },
    },
  ],
base: '/',
})
