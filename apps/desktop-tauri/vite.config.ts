import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(appRoot, '../..')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
      '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
      '@memry/domain-inbox': resolve(workspaceRoot, 'packages/domain-inbox/src'),
      '@memry/domain-notes': resolve(workspaceRoot, 'packages/domain-notes/src'),
      '@memry/domain-tasks': resolve(workspaceRoot, 'packages/domain-tasks/src'),
      '@memry/rpc': resolve(workspaceRoot, 'packages/rpc/src'),
      '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
      '@memry/sync-core': resolve(workspaceRoot, 'packages/sync-core/src')
    }
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'es2022',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG
  }
})
