import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Which build this is, for feedback/bug-report diagnostics: the git commit and the build date, e.g.
// "35d7e60 (2026-09-26)", with "+dirty" when built from uncommitted changes. VITE_APP_VERSION still
// overrides it. Falls back to "unknown" where git isn't available (a source tarball, say).
function buildVersion() {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION
  const date = new Date().toISOString().slice(0, 10)
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== ''
    return `${sha}${dirty ? '+dirty' : ''} (${date})`
  } catch {
    return `unknown (${date})`
  }
}

export default defineConfig({
  // Relative by default (dev server, any static host). Production is served under /app/, so deploys
  // build with VITE_BASE=/app/ — that keeps asset urls right on deep links like /app/some/route.
  base: process.env.VITE_BASE || './',
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(buildVersion()),
  },
})
