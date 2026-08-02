/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:2697',
        changeOrigin: true,
        // SSE streams stay open indefinitely — never let the dev proxy time them out
        // (docs/03-api.md §10.2): timeout = incoming socket, proxyTimeout = upstream.
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  test: {
    environment: 'jsdom',
    // unit tests only — e2e/*.spec.ts belongs to Playwright, never Vitest
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
