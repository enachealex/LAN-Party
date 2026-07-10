import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative base by default so the built client loads over file:// inside the Electron desktop
  // wrapper. For web hosting at a domain root, build with VITE_BASE=/ (see the Dockerfile).
  base: process.env.VITE_BASE || './',
  plugins: [react()]
})
