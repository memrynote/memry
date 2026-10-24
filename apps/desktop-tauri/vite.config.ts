import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { excalidrawSubsetWorker } from './scripts/excalidraw-subset-worker-plugin'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(appRoot, '../..')
// Same table as apps/desktop/electron.vite.config.ts minus `@memry/cli` and `@memry/app-core`:
// the Tauri renderer reaches neither.
const workspaceAliases = {
  '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
  '@memry/db-schema': resolve(workspaceRoot, 'packages/db-schema/src'),
  '@memry/domain-inbox': resolve(workspaceRoot, 'packages/domain-inbox/src'),
  '@memry/domain-notes': resolve(workspaceRoot, 'packages/domain-notes/src'),
  '@memry/domain-tasks': resolve(workspaceRoot, 'packages/domain-tasks/src'),
  '@memry/i18n': resolve(workspaceRoot, 'packages/i18n/src'),
  '@memry/rpc': resolve(workspaceRoot, 'packages/rpc/src'),
  '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
  '@memry/storage-data': resolve(workspaceRoot, 'packages/storage-data/src'),
  '@memry/storage-vault': resolve(workspaceRoot, 'packages/storage-vault/src'),
  '@memry/sync-core': resolve(workspaceRoot, 'packages/sync-core/src')
} as const

export default defineConfig({
  root: resolve(appRoot, 'src/renderer'),
  base: './',
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  define: {
    // react-grid-layout reads a bare `process.env` at runtime and the webview has no Node
    // `process`; no renderer source reads process.env, so replacing it with {} is safe.
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    'process.env': '{}'
  },
  resolve: {
    alias: {
      ...workspaceAliases,
      '@renderer': resolve(appRoot, 'src/renderer/src'),
      '@': resolve(appRoot, 'src/renderer/src')
    }
  },
  plugins: [react(), tailwindcss(), excalidrawSubsetWorker()],
  // Excalidraw constructs its subset worker with `{ type: 'module' }`; see
  // scripts/excalidraw-subset-worker-plugin.ts.
  worker: { format: 'es' },
  // Vite's dep optimizer passes esbuild its entry points in scan-finish order, so two
  // re-optimizations can emit different chunk layouts under one `?v=` hash and the HTTP
  // cache then runs both side by side (two copies of @blocknote/core, "Duplicate use of
  // selection JSON ID"). Sorted entries make the layout depend only on the dependency list.
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: 'sort-optimizer-entries',
          setup(build) {
            const { entryPoints } = build.initialOptions
            if (Array.isArray(entryPoints)) entryPoints.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          }
        }
      ]
    }
  },
  build: {
    outDir: resolve(appRoot, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      // `pdf-host.html` stays in the tree for Step 34 (#3551).
      input: { index: resolve(appRoot, 'src/renderer/index.html') },
      // Every per-icon module in @hugeicons/core-free-icons tags its array literal with
      // /*#__PURE__*/, which rollup only reads on calls; left alone it emits one notice per icon.
      onwarn(warning, defaultHandler) {
        const fromHugeicons =
          warning.id?.includes('@hugeicons/core-free-icons') ||
          warning.message.includes('@hugeicons/core-free-icons')
        if (warning.code === 'INVALID_ANNOTATION' && fromHugeicons) return
        defaultHandler(warning)
      }
    }
  }
})
