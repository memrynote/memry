import { posix } from 'node:path'
import type { Plugin } from 'vite'

// Excalidraw subsets export fonts in a module worker. It gets the worker URL by
// dynamically importing its own `subset-worker.chunk.js` and reading
// `import.meta.url`, so the same file serves as both a lazy chunk and a worker
// entry. Rollup only sees the lazy chunk: it hoists shared modules into chunks
// the page has already loaded, and the built worker chunk statically imported the
// renderer entry chunk. Inside the worker, that entry ran app modules until one
// read `window` at top level ("ReferenceError: window is not defined", #2530).
// Excalidraw caught it and fell back to main-thread subsetting, while the
// uncaught worker error reached the window `error` listener as a stackless
// `window_error`.
//
// This plugin swaps the lazy chunk for a module that exports only `WorkerUrl`,
// pointing at a `?worker&url` build of the same file. Vite bundles that as its
// own entry with its own dependency graph, so the worker never loads app code.
// Build only: in dev, esbuild pre-bundles Excalidraw and the chunk stays
// self-contained.

export const EXCALIDRAW_SUBSET_WORKER_CHUNK = 'subset-worker.chunk.js'
const EXCALIDRAW_DIST_SEGMENT = '/@excalidraw/excalidraw/dist/'
const VIRTUAL_ID_PREFIX = '\0excalidraw-subset-worker-url:'

export function excalidrawSubsetWorker(): Plugin {
  return {
    name: 'excalidraw-subset-worker',
    apply: 'build',
    // Vite's own resolver answers relative imports first unless this runs earlier.
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null
      const importerPath = importer.replaceAll('\\', '/')
      if (!importerPath.includes(EXCALIDRAW_DIST_SEGMENT)) return null
      if (source !== `./${EXCALIDRAW_SUBSET_WORKER_CHUNK}`) return null
      return VIRTUAL_ID_PREFIX + posix.join(posix.dirname(importerPath), source)
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_ID_PREFIX)) return null
      const workerPath = id.slice(VIRTUAL_ID_PREFIX.length)
      return [
        `import workerUrl from ${JSON.stringify(`${workerPath}?worker&url`)}`,
        'export const WorkerUrl = new URL(workerUrl, import.meta.url)',
        ''
      ].join('\n')
    }
  }
}
