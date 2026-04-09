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
  '@memry/db-schema': resolve(workspaceRoot, 'packages/db-schema/src'),
  '@memry/domain-inbox': resolve(workspaceRoot, 'packages/domain-inbox/src'),
  '@memry/domain-notes': resolve(workspaceRoot, 'packages/domain-notes/src'),
  '@memry/domain-tasks': resolve(workspaceRoot, 'packages/domain-tasks/src'),
  '@memry/rpc': resolve(workspaceRoot, 'packages/rpc/src'),
  '@memry/shared': resolve(workspaceRoot, 'packages/shared/src'),
  '@memry/storage-data': resolve(workspaceRoot, 'packages/storage-data/src'),
  '@memry/storage-vault': resolve(workspaceRoot, 'packages/storage-vault/src'),
  '@memry/sync-core': resolve(workspaceRoot, 'packages/sync-core/src')
} as const
const workspacePackages = Object.keys(workspaceAliases)

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
      externalizeDeps: {
        exclude: [
          ...workspacePackages,
          'cborg',
          '@blocknote/server-util',
          '@blocknote/core',
          '@blocknote/react',
          '@blocknote/xl-ai',
          '@handlewithcare/prosemirror-inputrules',
          'y-prosemirror'
        ]
      },
      rollupOptions: {
        input: {
          index: resolve(appRoot, 'src/main/index.ts'),
          'sync-worker': resolve(appRoot, 'src/main/sync/worker.ts'),
          'voice-transcription-worker': resolve(
            appRoot,
            'src/main/inbox/voice-transcription-worker.ts'
          )
        },
        external: ['better-sqlite3', 'jsdom', 'canvas']
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
    build: {
      externalizeDeps: {
        exclude: [...workspacePackages]
      }
    },
    resolve: {
      alias: {
        ...workspaceAliases,
        '@main': resolve(appRoot, 'src/main')
      }
    }
  },
  renderer: {
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
