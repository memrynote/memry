import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as schema from '@memry/db-schema/data-schema'

vi.mock('./vault-key', () => ({
  getLegacyCanvasVaultKey: async () => {
    throw new Error('no legacy key')
  }
}))
// The seam for adoption: listing skips links, so the document is swapped for
// one right after the listing saw a plain file.
const afterListing = vi.hoisted(() => ({ swap: (): void => {} }))
vi.mock('./scene-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scene-file')>()
  return {
    ...actual,
    listCanvasFiles: (vaultPath: string) => {
      const listed = actual.listCanvasFiles(vaultPath)
      afterListing.swap()
      afterListing.swap = () => {}
      return listed
    }
  }
})
vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

const { reconcileCanvasFiles } = await import('./reconcile')
const { CANVAS_DIR, withCanvasMeta } = await import('./scene-file')
const { readCanvasLibrary, writeCanvasLibrary, libraryFileRelativePath } =
  await import('./library-file')
const { createCanvas } = await import('./store')

const MIGRATIONS = [
  '0035_spatial_canvas.sql',
  '0036_canvas_assets.sql',
  '0038_canvas_library_items.sql',
  '0045_canvas_files.sql',
  '0048_canvas_folders.sql',
  '0057_sync_unknown_fields.sql',
  '0058_canvas_owner_note.sql',
  '0063_canvas_entity_edges.sql'
]

function freshDb() {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  for (const file of MIGRATIONS) {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'database', 'drizzle-data', file),
      'utf8'
    )
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement.trim())
    }
  }
  return drizzle(sqlite, { schema })
}

const SCENE = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r1' }] })
const OUTSIDE_SCENE = JSON.stringify({
  type: 'excalidraw',
  elements: [
    { id: 'r1', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } },
    { id: 'r2', type: 'rectangle', customData: { entityType: 'note', entityId: 'n2' } },
    {
      id: 'a1',
      type: 'arrow',
      startBinding: { elementId: 'r1' },
      endBinding: { elementId: 'r2' }
    }
  ]
})

const isWindows = process.platform === 'win32'

describe.skipIf(isWindows)('canvas readers against files linked outside the vault (#3098)', () => {
  let db: ReturnType<typeof freshDb>
  let vault: string
  let outside: string

  const linkOutside = (relativePath: string, content: string): string => {
    const secret = path.join(outside, path.basename(relativePath))
    fs.writeFileSync(secret, content)
    const file = path.join(vault, relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.rmSync(file, { force: true })
    fs.symlinkSync(secret, file)
    return secret
  }

  beforeEach(() => {
    db = freshDb()
    vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-link-vault-')))
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-link-out-')))
  })

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('never adopts a canvas document swapped for an outside link after the listing', async () => {
    const relativePath = `${CANVAS_DIR}/Secret.excalidraw`
    fs.mkdirSync(path.join(vault, CANVAS_DIR))
    fs.writeFileSync(path.join(vault, relativePath), SCENE)
    afterListing.swap = () => {
      linkOutside(
        relativePath,
        withCanvasMeta(SCENE, { id: 'outside-id', createdAt: 1, updatedAt: 1 })
      )
    }

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(0)
    expect(db.select().from(schema.canvases).all()).toEqual([])
  })

  it('never rebuilds arrow edges from a document swapped for an outside link', async () => {
    const created = createCanvas(db, vault, 'vault-1', { title: 'Plan', scene: SCENE })
    const filePath = db.select().from(schema.canvases).all()[0].filePath!
    linkOutside(
      filePath,
      withCanvasMeta(OUTSIDE_SCENE, { id: created.id, createdAt: 1, updatedAt: 1 })
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(db.select().from(schema.canvasEntityEdges).all()).toEqual([])
    expect(result.missingFiles).toBe(1)
    expect(db.select().from(schema.canvases).all()[0].deletedAt).toBeNull()
  })

  it('shows an empty shapes library when its file links outside the vault', () => {
    linkOutside(
      libraryFileRelativePath(),
      JSON.stringify({ type: 'excalidrawlib', libraryItems: [{ id: 'outside-item' }] })
    )

    expect(readCanvasLibrary(vault)).toEqual([])
  })

  it('leaves a shapes library linked outside the vault alone on save', () => {
    const outsideLibrary = JSON.stringify({ type: 'excalidrawlib', libraryItems: [] })
    const secret = linkOutside(libraryFileRelativePath(), outsideLibrary)

    expect(writeCanvasLibrary(vault, [])).toBe(false)
    expect(fs.lstatSync(path.join(vault, libraryFileRelativePath())).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(secret, 'utf8')).toBe(outsideLibrary)
  })
})
