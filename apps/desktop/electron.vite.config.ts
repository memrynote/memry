import { cpSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { excalidrawSubsetWorker } from './scripts/excalidraw-subset-worker-plugin'
import { recordDevBuild } from './scripts/dev-build-reuse.mts'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(appRoot, '../..')
const workspaceAliases = {
  '@memry/contracts': resolve(workspaceRoot, 'packages/contracts/src'),
  '@memry/app-core': resolve(workspaceRoot, 'packages/app-core/src'),
  // Before '@memry/cli': an alias matches by prefix, in order.
  '@memry/cli/sandbox/generate': resolve(workspaceRoot, 'apps/cli/src/sandbox/generate.ts'),
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
// electron-vite sets NODE_ENV before it loads this file: 'development' for
// `electron-vite dev`, 'production' for `electron-vite build`.
const isDevServer = process.env.NODE_ENV === 'development'

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

// English OCR data for the OCR utility (see src/main/file-text/tessdata/README.md).
// Copied under a fixed name because tesseract.js reads
// `<langPath>/eng.traineddata.gz`, and unpacked from app.asar (electron-builder
// asarUnpack) because Tesseract's own worker thread reads it with plain fs.
function copyOcrLanguageData(): Plugin {
  return {
    name: 'copy-ocr-language-data',
    writeBundle(options) {
      const outDir = options.dir ?? resolve(appRoot, 'out/main')
      cpSync(resolve(appRoot, 'src/main/file-text/tessdata'), resolve(outDir, 'tessdata'), {
        recursive: true,
        filter: (source) => !source.endsWith('.md')
      })
    }
  }
}

// Photos, scans, audio and video for the sandbox vault generator. Unpacked from
// app.asar (electron-builder asarUnpack) so attaching them is a plain file copy.
function copySandboxAssets(): Plugin {
  return {
    name: 'copy-sandbox-assets',
    writeBundle(options) {
      const outDir = options.dir ?? resolve(appRoot, 'out/main')
      cpSync(
        resolve(workspaceRoot, 'apps/cli/src/sandbox/assets'),
        resolve(outDir, 'sandbox-assets'),
        { recursive: true }
      )
    }
  }
}

export default defineConfig({
  main: {
    // At info level, each dev build of main lists every one of its output chunks.
    // Warnings still print.
    logLevel: isDevServer ? 'warn' : undefined,
    plugins: [
      copyMigrations(),
      copyOcrLanguageData(),
      copySandboxAssets(),
      ...(isDevServer ? [recordDevBuild(appRoot, 'main')] : [])
    ],
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
          // Electron-as-node child that bridges Antigravity CLI's stdio MCP
          // client to the in-process Vault MCP server (see agy-mcp-bridge.ts).
          'agy-mcp-bridge': resolve(appRoot, 'src/main/agent/cli/agy-mcp-bridge.ts'),
          'voice-transcription-worker': resolve(
            appRoot,
            'src/main/inbox/voice-transcription-worker.ts'
          ),
          'ocr-worker': resolve(appRoot, 'src/main/file-text/ocr-worker.ts')
        },
        // re2 is required inside a try/catch by @metascraper/helpers as an
        // optional speedup; the repo never builds it (allowBuilds: re2: false),
        // so keep it external WITHOUT shipping it — the require throws and
        // metascraper falls back to RegExp, exactly as it does today.
        // Same deal for `ws`: it optionally requires bufferutil + utf-8-validate
        // as native accelerators; they are never installed, so keep them external
        // and let ws fall back to its JS implementation.
        external: ['better-sqlite3', 'jsdom', 'canvas', 're2', 'bufferutil', 'utf-8-validate'],
        // Vite flags every `await import()` of a module that main also imports
        // statically, and each dev build repeats the whole list.
        // `electron-vite build` still reports them.
        onwarn(warning, defaultHandler) {
          const ineffectiveDynamicImport =
            warning.plugin === 'vite:reporter' &&
            warning.message.includes('dynamic import will not move module into another chunk')
          if (isDevServer && ineffectiveDynamicImport) return
          defaultHandler(warning)
        },
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
        '@main': resolve(appRoot, 'src/main'),
        // Main loads the full HugeIcons set only to export a note with a library
        // icon (#3245). In dev the package's `development` export condition picks
        // its barrel, which re-exports 5,000+ one-icon modules and draws one
        // rollup warning per module. Production already picks this single-file
        // build through the `production` condition, so dev now matches it.
        '@hugeicons/core-free-icons': resolve(
          appRoot,
          'node_modules/@hugeicons/core-free-icons/dist/esm/index.min.js'
        )
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
    plugins: isDevServer ? [recordDevBuild(appRoot, 'preload')] : [],
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
    plugins: [devCsp(), react(), tailwindcss(), excalidrawSubsetWorker()],
    // Excalidraw constructs its subset worker with `{ type: 'module' }`; see
    // scripts/excalidraw-subset-worker-plugin.ts.
    worker: { format: 'es' },
    // Vite's dep optimizer passes esbuild its entry points in the order their export
    // scans finish, so each re-optimization of the same dependencies emits a new chunk
    // layout under the same `?v=` hash. Deps are served as immutable, so the dev
    // profile's HTTP cache then runs both layouts side by side: two copies of
    // @blocknote/core register one selection type twice, and the editor fails with
    // "Duplicate use of selection JSON ID". Sorted entries make the layout depend only
    // on the dependency list, as the hash does. The import scanner shares these
    // plugins and passes no entry points.
    optimizeDeps: {
      esbuildOptions: {
        plugins: [
          {
            name: 'sort-optimizer-entries',
            setup(build) {
              const { entryPoints } = build.initialOptions
              if (Array.isArray(entryPoints)) entryPoints.sort()
            }
          }
        ]
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(appRoot, 'src/renderer/index.html'),
          // Never shown: the main process renders PDF pages here
          // (src/main/file-text/pdf-host.ts).
          'pdf-host': resolve(appRoot, 'src/renderer/pdf-host.html')
        },
        // No `manualChunks` here, unlike main above. The renderer emits 908 chunks and
        // exactly one is reachable from the entry without an `import()`, so chunking can
        // only move startup bytes around, never off the startup path. It can add to it:
        // `manualChunks` claims a module even when the module was reachable only lazily,
        // so a vendor rule matching one eager module drags its whole bucket into launch.
        // A measured react/Radix/motion/rest-of-node_modules split took the eager total
        // from 4,789,586 to 45,050,500 bytes by pulling in Shiki, Excalidraw, and Mermaid.
        // See apps/docs/src/architecture.md, "Renderer Chunking".

        // Every per-icon module in @hugeicons/core-free-icons tags its array literal
        // with /*#__PURE__*/, which rollup only reads on calls. Left alone it emits one
        // notice per icon and buries the warnings worth acting on.
        onwarn(warning, defaultHandler) {
          const fromHugeicons =
            warning.id?.includes('@hugeicons/core-free-icons') ||
            warning.message.includes('@hugeicons/core-free-icons')
          if (warning.code === 'INVALID_ANNOTATION' && fromHugeicons) return
          defaultHandler(warning)
        }
      }
    }
  }
})
