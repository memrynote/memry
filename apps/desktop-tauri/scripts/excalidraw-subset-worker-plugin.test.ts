import { describe, expect, it } from 'vitest'
import { excalidrawSubsetWorker } from './excalidraw-subset-worker-plugin'

const EXCALIDRAW_CHUNK =
  '/repo/node_modules/.pnpm/@excalidraw+excalidraw@0.18.1/node_modules/@excalidraw/excalidraw/dist/prod/chunk-K2UTITRG.js'

type ResolveId = (source: string, importer: string | undefined) => string | null
type Load = (id: string) => string | null

function hooks(): { resolveId: ResolveId; load: Load } {
  const plugin = excalidrawSubsetWorker()
  if (typeof plugin.resolveId !== 'function' || typeof plugin.load !== 'function') {
    throw new Error('excalidrawSubsetWorker must expose function hooks')
  }
  const resolveId = plugin.resolveId
  const load = plugin.load
  return {
    resolveId: (source, importer) =>
      resolveId.call({} as never, source, importer, { isEntry: false } as never) as string | null,
    load: (id) => load.call({} as never, id) as string | null
  }
}

describe('excalidrawSubsetWorker', () => {
  it('runs before Vite resolves relative imports, in builds only', () => {
    const plugin = excalidrawSubsetWorker()
    expect(plugin.enforce).toBe('pre')
    expect(plugin.apply).toBe('build')
  })

  it('replaces the lazy subset-worker chunk with a module that builds the worker as its own entry', () => {
    const { resolveId, load } = hooks()

    const id = resolveId('./subset-worker.chunk.js', EXCALIDRAW_CHUNK)
    expect(id).toMatch(/^\0excalidraw-subset-worker-url:/)

    const code = load(id as string)
    expect(code).toContain(
      'import workerUrl from "/repo/node_modules/.pnpm/@excalidraw+excalidraw@0.18.1/node_modules/@excalidraw/excalidraw/dist/prod/subset-worker.chunk.js?worker&url"'
    )
    expect(code).toContain('export const WorkerUrl = new URL(workerUrl, import.meta.url)')
  })

  it('normalizes Windows importer paths', () => {
    const { resolveId, load } = hooks()
    const id = resolveId(
      './subset-worker.chunk.js',
      'C:\\repo\\node_modules\\@excalidraw\\excalidraw\\dist\\prod\\chunk-K2UTITRG.js'
    )
    expect(load(id as string)).toContain(
      '"C:/repo/node_modules/@excalidraw/excalidraw/dist/prod/subset-worker.chunk.js?worker&url"'
    )
  })

  it('leaves every other import alone', () => {
    const { resolveId, load } = hooks()
    expect(resolveId('./subset-shared.chunk.js', EXCALIDRAW_CHUNK)).toBeNull()
    expect(resolveId('./subset-worker.chunk.js', '/repo/src/renderer/src/main.tsx')).toBeNull()
    expect(resolveId('./subset-worker.chunk.js', undefined)).toBeNull()
    expect(load('/repo/src/renderer/src/main.tsx')).toBeNull()
  })
})
