import { DatabaseSync } from 'node:sqlite'

import type { VaultDb } from '@/db/index'
import { MOBILE_MIGRATIONS } from '@/db/migrations'
import { OutboxStore } from '@/sync/outbox'
import type { NoteOpsContext } from '@/features/notes/note-ops'

/**
 * A REAL SQLite vault, built from the shipping migration ledger.
 *
 * Not a stub that pattern-matches SQL. A stub can only ever prove that the
 * code called it the way the stub expected, which is exactly the shape of
 * false confidence that has bitten this repo before: the query is wrong, the
 * fake does not care, the suite is green. `node:sqlite` runs the same SQL the
 * phone runs against the same schema, so a typo'd column or a `WHERE` that
 * matches nothing fails here.
 *
 * What it does NOT cover: expo-sqlite's own driver quirks and anything native.
 * A test here is evidence about the queries and the queue, not about the
 * device.
 */

export interface TestVault {
  db: VaultDb
  ctx: NoteOpsContext
  /** Every queued row, oldest first, decoded. */
  outboxRows(): { itemType: string; itemId: string; op: string; payload: unknown }[]
  close(): void
}

const decoder = new TextDecoder()

function adapt(raw: DatabaseSync): VaultDb {
  const run = (sql: string, params: unknown[] = []) => {
    raw.prepare(sql).run(...(params as never[]))
  }

  const db = {
    getAllAsync: <T>(sql: string, params: unknown[] = []) =>
      Promise.resolve(raw.prepare(sql).all(...(params as never[])) as T[]),
    getFirstAsync: <T>(sql: string, params: unknown[] = []) =>
      Promise.resolve((raw.prepare(sql).get(...(params as never[])) ?? null) as T | null),
    runAsync: (sql: string, params: unknown[] = []) => {
      run(sql, params)
      return Promise.resolve({ changes: 0, lastInsertRowId: 0 })
    },
    execAsync: (sql: string) => {
      raw.exec(sql)
      return Promise.resolve()
    },
    // `withVaultTransaction` serialises callers itself, so a plain BEGIN here
    // matches what expo-sqlite does on the single connection it hands out.
    withTransactionAsync: async (fn: () => Promise<void>) => {
      raw.exec('BEGIN')
      try {
        await fn()
        raw.exec('COMMIT')
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    },
    prepareAsync: (sql: string) => {
      const statement = raw.prepare(sql)
      return Promise.resolve({
        executeAsync: (params: unknown[] = []) => {
          statement.run(...(params as never[]))
          return Promise.resolve({})
        },
        finalizeAsync: () => Promise.resolve()
      })
    }
  }
  return db as unknown as VaultDb
}

export function openTestVault(vaultId = 'vault-1', deviceId = 'device-a'): TestVault {
  const raw = new DatabaseSync(':memory:')
  for (const migration of MOBILE_MIGRATIONS) raw.exec(migration.sql)

  const db = adapt(raw)
  const ctx: NoteOpsContext = { db, outbox: new OutboxStore(db), vaultId, deviceId }

  return {
    db,
    ctx,
    outboxRows() {
      const rows = raw
        .prepare('SELECT item_type, item_id, op, payload FROM outbox ORDER BY id ASC')
        .all() as { item_type: string; item_id: string; op: string; payload: unknown }[]
      return rows.map((row) => ({
        itemType: row.item_type,
        itemId: row.item_id,
        op: row.op,
        payload:
          row.payload instanceof Uint8Array
            ? (JSON.parse(decoder.decode(row.payload)) as unknown)
            : null
      }))
    },
    close: () => raw.close()
  }
}

/** Insert a note the way a pull would: full payload, no queue row. */
export function seedNote(
  vault: TestVault,
  input: { id: string; title: string; folderPath?: string; markdown?: string }
): void {
  const payload = JSON.stringify({
    title: input.title,
    folderPath: input.folderPath ?? null,
    tags: [],
    properties: {},
    clock: { 'device-remote': 1 },
    createdAt: 1_700_000_000_000,
    modifiedAt: 1_700_000_000_000
  })
  void vault.db.runAsync(
    `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
     VALUES (?, 'note', ?, ?, 'full', ?)`,
    [input.id, 'vault-1', 1_700_000_000_000, payload]
  )
  void vault.db.runAsync(
    `INSERT INTO note_bodies (item_id, path, markdown, fetched_at) VALUES (?, ?, ?, ?)`,
    [input.id, `${input.title}.md`, input.markdown ?? '', 1_700_000_000_000]
  )
}
