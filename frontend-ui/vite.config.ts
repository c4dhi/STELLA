import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// Get version: prefer VITE_APP_VERSION env var (Docker build), fallback to reading parent package.json (local dev)
function getAppVersion(): string {
  if (process.env.VITE_APP_VERSION) {
    return process.env.VITE_APP_VERSION
  }

  // Fallback for local development: read from parent package.json
  const parentPackagePath = resolve(__dirname, '../package.json')
  if (existsSync(parentPackagePath)) {
    const packageJson = JSON.parse(readFileSync(parentPackagePath, 'utf-8'))
    return packageJson.version
  }

  return '0.0.0'
}

const appVersion = getAppVersion()

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    // Default to localhost for secure context (crypto.subtle support)
    // Set VITE_HOST=0.0.0.0 to enable network access (mobile/tablet testing)
    host: process.env.VITE_HOST || 'localhost',
    port: 5173
  },
  test: {
    // Every test unmounts whatever it rendered, so a hook's own unmount
    // effects (cancelling a requestAnimationFrame, clearing a setInterval)
    // actually run instead of leaking into whatever test runs next (#987).
    setupFiles: ['./vitest.setup.ts']
  }
})
