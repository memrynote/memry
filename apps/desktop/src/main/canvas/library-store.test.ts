import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'

import * as schema from '@memry/db-schema/data-schema'
import type { CanvasLibraryItem } from '@memry/contracts/canvas-api'
import { listCanvasLibraryItems, saveCanvasLibraryItems } from './library-store'
import { decryptCanvasLibraryItemForVault, decryptCanvasSceneForVault } from './encryption'

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'drizzle-data', '0038_canvas_library_items.sql'),
  'utf8'
)

function freshDb() {
  const sqlite = new Database(':memory:')
  for (const statement of MIGRATION_SQL.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed) sqlite.exec(trimmed)
  }
  return drizzle(sqlite, { schema })
}

function item(id: string, extra: Record<string, unknown> = {}): CanvasLibraryItem {
  return {
    id,
    status: 'unpublished',
    created: 1,
    elements: [{ type: 'rectangle', id: `${id}-el` }],
    ...extra
  } as CanvasLibraryItem
}

const VAULT = 'vault-1'

describe('canvas library store', () => {
  let vaultKey: Uint8Array
  let db: ReturnType<typeof freshDb>

  beforeAll(async () => {
    await sodium.ready
    vaultKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  })

  beforeEach(() => {
    db = freshDb()
  })

  it('stores items encrypted and reads them back verbatim', () => {
    const changed = saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a'), item('b')])

    expect(changed).toBe(2)

    const raw = db.select().from(schema.canvasLibraryItems).all()
    expect(raw).toHaveLength(2)
    expect(raw[0].itemCiphertext).not.toContain('rectangle')
    expect(JSON.parse(decryptCanvasLibraryItemForVault(raw[0].itemCiphertext, vaultKey))).toEqual(
      item('a')
    )

    expect(listCanvasLibraryItems(db, vaultKey, VAULT)).toEqual([item('a'), item('b')])
  })

  it('preserves fields it does not know about', () => {
    // An Excalidraw upgrade that adds a LibraryItem field must round-trip, or
    // saving would quietly strip data the panel depends on.
    saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a', { futureField: { nested: true } })])

    expect(listCanvasLibraryItems(db, vaultKey, VAULT)[0]).toMatchObject({
      futureField: { nested: true }
    })
  })

  it('is idempotent when the same list is saved twice', () => {
    const items = [item('a'), item('b')]
    saveCanvasLibraryItems(db, vaultKey, VAULT, items)

    expect(saveCanvasLibraryItems(db, vaultKey, VAULT, items)).toBe(0)
  })

  it('soft-deletes items dropped from the list', () => {
    saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a'), item('b')])
    saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a')])

    expect(listCanvasLibraryItems(db, vaultKey, VAULT).map((i) => i.id)).toEqual(['a'])

    // The row survives as a tombstone — a hard delete would let the item come
    // back from another device once this table syncs.
    const rows = db.select().from(schema.canvasLibraryItems).all()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === 'b')?.deletedAt).toBeTypeOf('number')
  })

  it('revives a tombstoned item when the user re-adds it', () => {
    saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a')])
    saveCanvasLibraryItems(db, vaultKey, VAULT, [])
    saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a', { name: 'Back' })])

    const live = listCanvasLibraryItems(db, vaultKey, VAULT)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ id: 'a', name: 'Back' })
  })

  it('scopes the library to its vault', () => {
    saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a')])
    saveCanvasLibraryItems(db, vaultKey, 'vault-2', [item('b')])

    expect(listCanvasLibraryItems(db, vaultKey, VAULT).map((i) => i.id)).toEqual(['a'])
    expect(listCanvasLibraryItems(db, vaultKey, 'vault-2').map((i) => i.id)).toEqual(['b'])
  })

  it('skips an unreadable row instead of losing the whole library', () => {
    saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a'), item('b')])
    db.update(schema.canvasLibraryItems)
      .set({ itemCiphertext: 'not-an-envelope' })
      .where(eq(schema.canvasLibraryItems.id, 'a'))
      .run()

    expect(listCanvasLibraryItems(db, vaultKey, VAULT).map((i) => i.id)).toEqual(['b'])
  })

  it('does not decrypt under the scene purpose', () => {
    // Distinct associated data means a library ciphertext cannot be swapped
    // into a canvases row and still authenticate.
    saveCanvasLibraryItems(db, vaultKey, VAULT, [item('a')])
    const raw = db.select().from(schema.canvasLibraryItems).all()[0]

    expect(() => decryptCanvasSceneForVault(raw.itemCiphertext, vaultKey)).toThrow()
  })
})
