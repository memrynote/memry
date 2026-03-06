import { cpSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(appRoot, '../..')

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
      cpSync(resolve(appRoot, 'src/main/database/drizzle-index'), resolve(outDir, 'drizzle-index'), {
        recursive: true
      })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [copyMigrations()],
    build: {
      externalizeDeps: {
        exclude: [
          'cborg',
          '@blocknote/server-util',
          '@blocknote/core',
          '@blocknote/react',
          '@handlewithcare/prosemirror-inputrules',
          'y-prosemirror'
        ]
      },
      rollupOptions: {
        input: {
          index: resolve(appRoot, 'src/main/index.ts'),
          'sync-worker': resolve(appRoot, 'src/main/sync/worker.ts')
        },
        external: ['better-sqlite3', 'jsdom', 'canvas']
      }
    },
    resolve: {
      alias: {
        '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
        '@memry/db-schema': resolve(workspaceRoot, 'packages/db-schema/src'),
        '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
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
        '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
        '@memry/db-schema': resolve(workspaceRoot, 'packages/db-schema/src'),
        '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
        '@main': resolve(appRoot, 'src/main')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
        '@memry/db-schema': resolve(workspaceRoot, 'packages/db-schema/src'),
        '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
        '@main': resolve(appRoot, 'src/main'),
        '@renderer': resolve(appRoot, 'src/renderer/src'),
        '@': resolve(appRoot, 'src/renderer/src')
      }
    },
    plugins: [devCsp(), react(), tailwindcss()]
  }
})
