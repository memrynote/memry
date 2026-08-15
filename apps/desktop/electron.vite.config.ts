import { cpSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(appRoot, '../..')
const workspaceAliases = {
  '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
  '@memry/app-core': resolve(workspaceRoot, 'packages/app-core/src'),
  '@memry/cli': resolve(workspaceRoot, 'apps/cli/src/run.ts'),
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

function devCsp(): Plugin {
  return {
    name: 'dev-csp',
    transformIndexHtml(html) {
      if (process.env.NODE_ENV !== 'production') {
        return html.replace("script-src 'self'", "script-src 'self' 'unsafe-eval' 'unsafe-inline'")
      }
      return html
    }
  }
}

function copyMigrations(): Plugin {
  return {
    name: 'copy-drizzle-migrations',
    writeBundle(options) {
      const outDir = options.dir ?? resolve(appRoot, 'out/main')
      cpSync(resolve(appRoot, 'src/main/database/drizzle-data'), resolve(outDir, 'drizzle-data'), {
        recursive: true
      })
      cpSync(
        resolve(appRoot, 'src/main/database/drizzle-index'),
        resolve(outDir, 'drizzle-index'),
        {
          recursive: true
        }
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [copyMigrations()],
    build: {
      // Dependency contract: package.json `dependencies` = native/unbundleable
      // modules only — electron-vite externalizes them by default and pnpm
      // deploy ships them loose. Everything in `devDependencies` gets bundled
      // into out/. Keep `dependencies` minimal: macOS Squirrel verifies every
      // loose file on auto-update, so restart time is O(shipped file count).
      // See docs/auto-update-slow-restart-investigation.md.
      rollupOptions: {
        input: {
          index: resolve(appRoot, 'src/main/index.ts'),
          'embedding-worker': resolve(appRoot, 'src/main/lib/embedding-worker.ts'),
          'sync-worker': resolve(appRoot, 'src/main/sync/worker.ts'),
          // utilityProcess child that exercises the classic-level native
          // binding before main loads it (see crdt-preflight.ts)
          'crdt-preflight-child': resolve(appRoot, 'src/main/sync/crdt-preflight-child.ts'),
          // worker_threads child that builds a large file's line-offset index
          // (see large-file-index-bridge.ts). Without this entry the bridge
          // silently falls back to scanning in-process.
          'large-file-index-worker': resolve(appRoot, 'src/main/vault/large-file-index-worker.ts'),
          'image-processing-worker': resolve(appRoot, 'src/main/image-processing/worker.ts'),
          'voice-transcription-worker': resolve(
            appRoot,
            'src/main/inbox/voice-transcription-worker.ts'
          )
        },
        // re2 is required inside a try/catch by @metascraper/helpers as an
        // optional speedup; the repo never builds it (allowBuilds: re2: false),
        // so keep it external WITHOUT shipping it — the require throws and
        // metascraper falls back to RegExp, exactly as it does today.
        // Same deal for `ws`: it optionally requires bufferutil + utf-8-validate
        // as native accelerators; they are never installed, so keep them external
        // and let ws fall back to its JS implementation.
        external: ['better-sqlite3', 'jsdom', 'canvas', 're2', 'bufferutil', 'utf-8-validate'],
        output: {
          // Keep each bundled npm package in its own chunk. The main process is
          // CJS output, and rollup's default chunking can split a package's
          // internally-circular modules (zod v4, yjs, …) across shared chunks,
          // where CJS load order breaks them (observed: zod's `_enum` undefined
          // at boot). Package-per-chunk keeps intra-package cycles inside one
          // module scope; chunk count inside app.asar is free for codesign.
          manualChunks(id) {
            const match = id.match(
              /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//
            )
            if (match) {
              return `dep-${match[1].replace('/', '_')}`
            }
            return undefined
          }
        }
      }
    },
    resolve: {
      alias: {
        ...workspaceAliases,
        '@main': resolve(appRoot, 'src/main')
      },
      dedupe: [
        'prosemirror-model',
        'prosemirror-state',
        'prosemirror-view',
        'prosemirror-transform'
      ]
    }
  },
  preload: {
    resolve: {
      alias: {
        ...workspaceAliases,
        '@main': resolve(appRoot, 'src/main')
      }
    }
  },
  renderer: {
    define: {
      // react-grid-layout reads a bare `process.env` at runtime. The contextIsolated renderer has
      // no Node `process`, so without this it throws "process is not defined" inside RGL's drag/
      // resize handlers — interaction silently does nothing while widgets still render. No renderer
      // source reads process.env, so replacing it with {} is safe.
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
      'process.env': '{}'
    },
    resolve: {
      alias: {
        ...workspaceAliases,
        '@main': resolve(appRoot, 'src/main'),
        '@renderer': resolve(appRoot, 'src/renderer/src'),
        '@': resolve(appRoot, 'src/renderer/src')
      }
    },
    plugins: [devCsp(), react(), tailwindcss()]
  }
})
