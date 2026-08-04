import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CANVAS_DIR,
  allocateCanvasPath,
  deleteCanvasFileSync,
  listCanvasFiles,
  readCanvasFileSync,
  readCanvasMeta,
  renameCanvasFile,
  resolveCanvasFile,
  stripCanvasMeta,
  withCanvasMeta,
  writeCanvasFileSync
} from './scene-file'

const META = { id: 'cnv1', createdAt: 1000, updatedAt: 2000 }

let vault: string

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'memry-canvas-file-'))
})

afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('withCanvasMeta', () => {
  it('keeps the document a valid Excalidraw file and embeds the memry sidecar', () => {
    const scene = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: [{ id: 'a' }],
      appState: { viewBackgroundColor: '#fff' },
      files: {}
    })

    const parsed = JSON.parse(withCanvasMeta(scene, META))

    expect(parsed.type).toBe('excalidraw')
    expect(parsed.elements).toEqual([{ id: 'a' }])
    expect(parsed.appState).toEqual({ viewBackgroundColor: '#fff' })
    expect(parsed.memry).toEqual(META)
  })

  it('writes an empty document for a never-drawn canvas', () => {
    const parsed = JSON.parse(withCanvasMeta('', META))

    expect(parsed.type).toBe('excalidraw')
    expect(parsed.elements).toEqual([])
    expect(parsed.memry).toEqual(META)
  })

  it('carries unknown top-level keys through (memryAssets and friends)', () => {
    const scene = JSON.stringify({
      type: 'excalidraw',
      elements: [],
      memryAssets: [{ contentHash: 'h1' }]
    })

    const parsed = JSON.parse(withCanvasMeta(scene, META))

    expect(parsed.memryAssets).toEqual([{ contentHash: 'h1' }])
  })

  it('emits one canonical text regardless of input key order', () => {
    const a = JSON.stringify({ type: 'excalidraw', elements: [], zebra: 1, alpha: 2 })
    const b = JSON.stringify({ alpha: 2, elements: [], zebra: 1, type: 'excalidraw' })

    expect(withCanvasMeta(a, META)).toBe(withCanvasMeta(b, META))
  })

  it('does not throw away the canvas when the scene is not JSON', () => {
    const parsed = JSON.parse(withCanvasMeta('not json at all', META))

    expect(parsed.elements).toEqual([])
    expect(parsed.memry.id).toBe('cnv1')
  })
})

describe('stripCanvasMeta', () => {
  it('round-trips: the stripped scene carries no memry key', () => {
    const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a' }] })

    const stripped = stripCanvasMeta(withCanvasMeta(scene, META))

    expect(JSON.parse(stripped).memry).toBeUndefined()
    expect(JSON.parse(stripped).elements).toEqual([{ id: 'a' }])
  })

  it('is stable across two devices holding the same ink under different ids', () => {
    const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a' }] })

    const deviceA = withCanvasMeta(scene, { id: 'A', createdAt: 1, updatedAt: 2 })
    const deviceB = withCanvasMeta(scene, { id: 'B', createdAt: 9, updatedAt: 9 })

    expect(stripCanvasMeta(deviceA)).toBe(stripCanvasMeta(deviceB))
  })

  it('is idempotent: stripping an already-stripped scene changes nothing', () => {
    const scene = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a' }], memryAssets: [] })
    const once = stripCanvasMeta(withCanvasMeta(scene, META))

    expect(stripCanvasMeta(withCanvasMeta(once, META))).toBe(once)
  })

  it('returns an empty string for an empty file', () => {
    expect(stripCanvasMeta('')).toBe('')
  })
})

describe('readCanvasMeta', () => {
  it('reads the id back out of a file written elsewhere', () => {
    expect(readCanvasMeta(withCanvasMeta('', META))).toEqual(META)
  })

  it('returns null for a hand-made Excalidraw file with no sidecar', () => {
    expect(readCanvasMeta(JSON.stringify({ type: 'excalidraw', elements: [] }))).toBeNull()
  })

  it('returns null for junk', () => {
    expect(readCanvasMeta('<html>')).toBeNull()
  })
})

describe('file io', () => {
  it('writes atomically and reads back', () => {
    const rel = path.join(CANVAS_DIR, 'Plan.excalidraw')

    writeCanvasFileSync(resolveCanvasFile(vault, rel), withCanvasMeta('', META))

    expect(readCanvasMeta(readCanvasFileSync(resolveCanvasFile(vault, rel))!)).toEqual(META)
    // no leftover temp files
    expect(existsSync(resolveCanvasFile(vault, rel))).toBe(true)
  })

  it('reading a missing file is null, not a throw', () => {
    expect(readCanvasFileSync(resolveCanvasFile(vault, 'canvases/nope.excalidraw'))).toBeNull()
  })

  it('deleting a missing file is a no-op', () => {
    expect(() =>
      deleteCanvasFileSync(resolveCanvasFile(vault, 'canvases/nope.excalidraw'))
    ).not.toThrow()
  })

  it('lists only canvas documents', () => {
    mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    writeFileSync(path.join(vault, CANVAS_DIR, 'A.excalidraw'), '{}')
    writeFileSync(path.join(vault, CANVAS_DIR, 'library.excalidrawlib'), '{}')
    writeFileSync(path.join(vault, CANVAS_DIR, 'notes.md'), '#')

    expect(listCanvasFiles(vault)).toEqual([path.join(CANVAS_DIR, 'A.excalidraw')])
  })

  it('lists nothing when the vault has no canvases directory', () => {
    expect(listCanvasFiles(vault)).toEqual([])
  })
})

describe('allocateCanvasPath', () => {
  it('names the file after the title', () => {
    expect(allocateCanvasPath(vault, 'Istanbul Weekend')).toBe(
      path.join(CANVAS_DIR, 'Istanbul Weekend.excalidraw')
    )
  })

  it('falls back to Canvas for an empty title', () => {
    expect(allocateCanvasPath(vault, null)).toBe(path.join(CANVAS_DIR, 'Canvas.excalidraw'))
  })

  it('never returns a path that already exists on disk', () => {
    mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    writeFileSync(path.join(vault, CANVAS_DIR, 'Plan.excalidraw'), '{}')

    expect(allocateCanvasPath(vault, 'Plan')).toBe(path.join(CANVAS_DIR, 'Plan 2.excalidraw'))
  })

  it('never collides with a path claimed earlier in the same batch', () => {
    const taken = new Set([path.join(CANVAS_DIR, 'Plan.excalidraw')])

    expect(allocateCanvasPath(vault, 'Plan', taken)).toBe(
      path.join(CANVAS_DIR, 'Plan 2.excalidraw')
    )
  })

  it('strips path traversal out of the title', () => {
    const allocated = allocateCanvasPath(vault, '../../etc/passwd')

    expect(allocated.startsWith(CANVAS_DIR + path.sep)).toBe(true)
    expect(allocated).not.toContain('..')
  })
})

describe('renameCanvasFile', () => {
  it('moves the file and returns the new path', () => {
    const from = path.join(CANVAS_DIR, 'Old.excalidraw')
    const to = path.join(CANVAS_DIR, 'New.excalidraw')
    writeCanvasFileSync(resolveCanvasFile(vault, from), withCanvasMeta('', META))

    expect(renameCanvasFile(vault, from, to)).toBe(to)
    expect(existsSync(resolveCanvasFile(vault, to))).toBe(true)
    expect(existsSync(resolveCanvasFile(vault, from))).toBe(false)
  })

  it('keeps the old path when the file is missing, rather than losing the row', () => {
    const from = path.join(CANVAS_DIR, 'Gone.excalidraw')
    const to = path.join(CANVAS_DIR, 'New.excalidraw')

    expect(renameCanvasFile(vault, from, to)).toBe(from)
  })

  it('writes JSON a human can read in git', () => {
    const rel = path.join(CANVAS_DIR, 'Pretty.excalidraw')
    writeCanvasFileSync(resolveCanvasFile(vault, rel), withCanvasMeta('', META))

    expect(readFileSync(resolveCanvasFile(vault, rel), 'utf-8')).toContain(
      '\n  "type": "excalidraw"'
    )
  })
})
