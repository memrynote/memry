import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'

const legacyVaultKey = vi.hoisted(() => ({ current: null as Uint8Array | null }))

vi.mock('./vault-key', () => ({
  getLegacyCanvasVaultKey: async () => {
    if (!legacyVaultKey.current) throw new Error('Current master key does not match this vault')
    return legacyVaultKey.current
  }
}))

const { reconcileCanvasFiles } = await import('./reconcile')
const { encryptCanvasSceneForVault, encryptCanvasLibraryItemForVault } =
  await import('./encryption')
const { CANVAS_DIR, readCanvasMeta, withCanvasMeta } = await import('./scene-file')
const { readCanvasLibrary } = await import('./library-file')

const MIGRATIONS = [
  '0035_spatial_canvas.sql',
  '0038_canvas_library_items.sql',
  '0045_canvas_files.sql'
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
      const trimmed = statement.trim()
      if (trimmed) sqlite.exec(trimmed)
    }
  }
  return drizzle(sqlite, { schema })
}

const SCENE = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r1' }] })

let db: ReturnType<typeof freshDb>
let vault: string
let vaultKey: Uint8Array

function insertLegacyRow(id: string, title: string, ciphertext: string): void {
  db.insert(schema.canvases)
    .values({
      id,
      vaultId: 'vault-1',
      title,
      filePath: null,
      snapshotCiphertext: ciphertext,
      vectorClock: {},
      createdAt: 1000,
      updatedAt: 2000,
      deletedAt: null,
      lastSyncedAt: null,
      clock: null
    })
    .run()
}

beforeAll(async () => {
  await sodium.ready
  vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
})

beforeEach(() => {
  db = freshDb()
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-canvas-reconcile-'))
  legacyVaultKey.current = vaultKey
})

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true })
})

describe('legacy migration', () => {
  it('writes the encrypted snapshot out as a file and blanks the ciphertext', async () => {
    insertLegacyRow('c1', 'Weekend Plan', encryptCanvasSceneForVault(SCENE, vaultKey))

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.migrated).toBe(1)
    const row = db.select().from(schema.canvases).all()[0]
    expect(row.filePath).toBe(path.join(CANVAS_DIR, 'Weekend Plan.excalidraw'))
    expect(row.snapshotCiphertext).toBe('')
    const onDisk = fs.readFileSync(path.join(vault, row.filePath!), 'utf8')
    expect(JSON.parse(onDisk).elements).toEqual([{ id: 'r1' }])
    expect(readCanvasMeta(onDisk)).toEqual({ id: 'c1', createdAt: 1000, updatedAt: 2000 })
  })

  it('is idempotent — a second open migrates nothing', async () => {
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))

    await reconcileCanvasFiles(db, vault, 'vault-1')
    const second = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(second.migrated).toBe(0)
    expect(second.adopted).toBe(0)
  })

  it('KEEPS the ciphertext when the master key has moved on, and reports it', async () => {
    // This is the free → paid upgrade: the account master key replaced the local
    // one, so the old snapshot no longer decrypts.
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))
    legacyVaultKey.current = sodium.randombytes_buf(
      sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.unreadable).toBe(1)
    expect(result.migrated).toBe(0)
    const row = db.select().from(schema.canvases).all()[0]
    expect(row.filePath).toBeNull()
    // The only copy of that ink is still on disk, recoverable if the old key returns.
    expect(row.snapshotCiphertext).not.toBe('')
  })

  it('survives having no vault key at all (copied vault, no keychain)', async () => {
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))
    legacyVaultKey.current = null

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.unreadable).toBe(1)
    expect(db.select().from(schema.canvases).all()[0].snapshotCiphertext).not.toBe('')
  })

  it('gives same-titled legacy canvases distinct files', async () => {
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))
    insertLegacyRow('c2', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))

    await reconcileCanvasFiles(db, vault, 'vault-1')

    const paths = db
      .select({ filePath: schema.canvases.filePath })
      .from(schema.canvases)
      .all()
      .map((row) => row.filePath)
    expect(new Set(paths).size).toBe(2)
  })

  it('migrates the encrypted shapes library into one excalidrawlib file', async () => {
    db.insert(schema.canvasLibraryItems)
      .values({
        id: 'lib1',
        vaultId: 'vault-1',
        itemCiphertext: encryptCanvasLibraryItemForVault(
          JSON.stringify({ id: 'lib1', elements: [] }),
          vaultKey
        ),
        vectorClock: {},
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        lastSyncedAt: null,
        clock: null
      })
      .run()

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.libraryItemsMigrated).toBe(1)
    expect(readCanvasLibrary(vault)).toEqual([{ id: 'lib1', elements: [] }])
    // Second open must not duplicate them.
    expect((await reconcileCanvasFiles(db, vault, 'vault-1')).libraryItemsMigrated).toBe(0)
  })
})

describe('adoption', () => {
  it('adopts a canvas that arrived with a copied vault folder', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'From USB.excalidraw'),
      withCanvasMeta(SCENE, { id: 'copied-1', createdAt: 5, updatedAt: 6 })
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(1)
    const row = db.select().from(schema.canvases).all()[0]
    expect(row).toMatchObject({
      id: 'copied-1',
      title: 'From USB',
      filePath: path.join(CANVAS_DIR, 'From USB.excalidraw'),
      createdAt: 5,
      // Null clock so the next sync seeds it out to the user's other devices.
      clock: null
    })
  })

  it('adopts a hand-made Excalidraw file and stamps an id into it', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    fs.writeFileSync(path.join(vault, CANVAS_DIR, 'Sketch.excalidraw'), SCENE)

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(1)
    const content = fs.readFileSync(path.join(vault, CANVAS_DIR, 'Sketch.excalidraw'), 'utf8')
    expect(readCanvasMeta(content)?.id).toBe(db.select().from(schema.canvases).all()[0].id)
  })

  it('re-points the index instead of duplicating when a file was renamed outside the app', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Original.excalidraw'),
      withCanvasMeta(SCENE, { id: 'c1', createdAt: 5, updatedAt: 6 })
    )
    await reconcileCanvasFiles(db, vault, 'vault-1')
    fs.renameSync(
      path.join(vault, CANVAS_DIR, 'Original.excalidraw'),
      path.join(vault, CANVAS_DIR, 'Renamed In Finder.excalidraw')
    )

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.adopted).toBe(0)
    expect(db.select().from(schema.canvases).all()).toHaveLength(1)
    expect(db.select().from(schema.canvases).all()[0].filePath).toBe(
      path.join(CANVAS_DIR, 'Renamed In Finder.excalidraw')
    )
  })

  it('indexes the entity refs an adopted scene references', async () => {
    fs.mkdirSync(path.join(vault, CANVAS_DIR), { recursive: true })
    fs.writeFileSync(
      path.join(vault, CANVAS_DIR, 'Linked.excalidraw'),
      withCanvasMeta(
        JSON.stringify({
          type: 'excalidraw',
          elements: [
            { id: 'r1', type: 'rectangle', customData: { entityType: 'note', entityId: 'n1' } }
          ]
        }),
        { id: 'c9', createdAt: 1, updatedAt: 1 }
      )
    )

    await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(db.select().from(schema.canvasEntityRefs).all()).toMatchObject([
      { canvasId: 'c9', entityType: 'note', entityId: 'n1' }
    ])
  })

  it('reports a missing document but NEVER tombstones the row', async () => {
    insertLegacyRow('c1', 'Plan', encryptCanvasSceneForVault(SCENE, vaultKey))
    await reconcileCanvasFiles(db, vault, 'vault-1')
    const row = db.select().from(schema.canvases).all()[0]
    fs.rmSync(path.join(vault, row.filePath!))

    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result.missingFiles).toBe(1)
    // A half-copied vault must never delete canvases.
    expect(db.select().from(schema.canvases).all()[0].deletedAt).toBeNull()
  })

  it('does nothing, loudly or otherwise, for a vault with no canvases', async () => {
    const result = await reconcileCanvasFiles(db, vault, 'vault-1')

    expect(result).toEqual({
      migrated: 0,
      unreadable: 0,
      adopted: 0,
      missingFiles: 0,
      libraryItemsMigrated: 0
    })
  })
})
