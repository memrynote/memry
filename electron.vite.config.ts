import { resolve } from 'path'
import { cpSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

function copyMigrations(): Plugin {
  return {
    name: 'copy-drizzle-migrations',
    writeBundle(options) {
      const outDir = options.dir ?? resolve('out/main')
      cpSync(resolve('src/main/database/drizzle-data'), resolve(outDir, 'drizzle-data'), {
        recursive: true
      })
      cpSync(resolve('src/main/database/drizzle-index'), resolve(outDir, 'drizzle-index'), {
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
          index: resolve('src/main/index.ts'),
          'sync-worker': resolve('src/main/sync/worker.ts')
        },
        external: ['better-sqlite3', 'jsdom', 'canvas']
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
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
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
