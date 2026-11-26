import { CrdtManifestResponseSchema } from '@memry/contracts/sync-api'
import { describe, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { getCrdtManifestPage } from './crdt-manifest'

// GET /sync/crdt/manifest (#5232): the metadata a pack reader checks its packed
// bodies against (protocol 08 §8.4.3, §8.10), over the real migrated schema.

const USER = 'user-1'
const VAULT = 'vault-1'

const setup = (): SqliteD1 => {
  const harness = createSqliteD1()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, 1, 1)`
    )
    .run(USER, 'user-1@example.com')
  return harness
}

const insertUpdate = (h: SqliteD1, noteId: string, seq: number, vaultId = VAULT): void => {
  h.raw
    .prepare(
      `INSERT INTO crdt_updates (id, user_id, vault_id, note_id, update_data, sequence_num, signer_device_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'device-1', 1)`
    )
    .run(`${vaultId}-${noteId}-${seq}`, USER, vaultId, noteId, Buffer.from('ciphertext'), seq)
}

const insertSnapshot = (h: SqliteD1, noteId: string, seq: number, revision: string): void => {
  h.raw
    .prepare(
      `INSERT INTO crdt_snapshots (id, user_id, vault_id, note_id, blob_key, sequence_num, size_bytes, signer_device_id, created_at, revision)
       VALUES (?, ?, ?, ?, 'key', ?, 42, 'device-1', 7, ?)`
    )
    .run(`snap-${noteId}`, USER, VAULT, noteId, seq, revision)
}

const insertFloor = (h: SqliteD1, noteId: string, floor: number): void => {
  h.raw
    .prepare(
      'INSERT INTO crdt_sequence_floors (user_id, vault_id, note_id, floor) VALUES (?, ?, ?, ?)'
    )
    .run(USER, VAULT, noteId, floor)
}

const readAll = async (h: SqliteD1, limit: number) => {
  const pages = []
  let cursor = ''
  for (;;) {
    const page = await getCrdtManifestPage(h.db, USER, VAULT, cursor, limit)
    pages.push(page)
    if (page.nextCursor === null) return pages
    cursor = page.nextCursor
  }
}

describe('getCrdtManifestPage', () => {
  it('answers floor, snapshot and highest update per document, with no ciphertext', async () => {
    const h = setup()
    insertUpdate(h, 'a-updates', 1)
    insertUpdate(h, 'a-updates', 2)
    insertSnapshot(h, 'b-snapshot', 4, 'rev-b')
    insertUpdate(h, 'b-snapshot', 5)
    insertFloor(h, 'c-purged', 9)
    insertFloor(h, 'd-recreated', 3)
    insertUpdate(h, 'd-recreated', 4)
    insertSnapshot(h, 'e-legacy', 2, '')
    insertUpdate(h, 'f-other-vault', 1, 'vault-2')

    const page = await getCrdtManifestPage(h.db, USER, VAULT, '', 1000)

    expect(CrdtManifestResponseSchema.parse(page)).toEqual(page)
    expect(page).toEqual({
      documents: [
        { noteId: 'a-updates', floor: 0, snapshot: null, maxSequenceNum: 2 },
        {
          noteId: 'b-snapshot',
          floor: 0,
          snapshot: { revision: 'rev-b', sequenceNum: 4 },
          maxSequenceNum: 5
        },
        { noteId: 'c-purged', floor: 9, snapshot: null, maxSequenceNum: 0 },
        { noteId: 'd-recreated', floor: 3, snapshot: null, maxSequenceNum: 4 },
        {
          noteId: 'e-legacy',
          floor: 0,
          // The token GET /sync/crdt/snapshot answers for a pre-revision row.
          snapshot: { revision: 'legacy:snap-e-legacy:7:42', sequenceNum: 2 },
          maxSequenceNum: 0
        }
      ],
      nextCursor: null
    })
  })

  it('pages every document exactly once in ascending id order', async () => {
    const h = setup()
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']
    ids.forEach((id, i) => {
      if (i % 3 === 0) insertUpdate(h, id, 1)
      if (i % 3 === 1) insertSnapshot(h, id, 1, `rev-${id}`)
      if (i % 3 === 2) insertFloor(h, id, 1)
    })
    insertUpdate(h, 'n1', 2)
    insertUpdate(h, 'n1', 3)

    const pages = await readAll(h, 2)

    expect(pages.map((page) => page.documents.map((d) => d.noteId))).toEqual([
      ['n1', 'n2'],
      ['n3', 'n4'],
      ['n5', 'n6'],
      ['n7']
    ])
    expect(pages.map((page) => page.nextCursor)).toEqual(['n2', 'n4', 'n6', null])
  })

  it('reads a vault of 1,001 documents in two requests within the bind limit', async () => {
    const h = setup()
    const ids = Array.from({ length: 1001 }, (_, i) => `note-${String(i).padStart(4, '0')}`)
    for (const id of ids) insertUpdate(h, id, 1)

    const pages = await readAll(h, 1000)

    expect(pages.map((page) => page.documents.length)).toEqual([1000, 1])
    expect(pages.flatMap((page) => page.documents.map((d) => d.noteId))).toEqual(ids)
  })

  it('reads the floor and snapshot of one document in the same batch', async () => {
    // #given: a purge commits between the page's key read and its batch
    const h = setup()
    insertSnapshot(h, 'doc', 4, 'rev-old')
    insertUpdate(h, 'doc', 5)
    const batch = h.db.batch.bind(h.db)
    h.db.batch = async (statements: D1PreparedStatement[]) => {
      h.raw.prepare('DELETE FROM crdt_updates').run()
      h.raw.prepare('DELETE FROM crdt_snapshots').run()
      insertFloor(h, 'doc', 5)
      return batch(statements)
    }

    const page = await getCrdtManifestPage(h.db, USER, VAULT, '', 1000)

    // #then: the purged state whole, never the old snapshot beside floor 0
    expect(page.documents).toEqual([{ noteId: 'doc', floor: 5, snapshot: null, maxSequenceNum: 0 }])
  })

  it('reads every table through an index', async () => {
    const h = setup()
    const sqls: string[] = []
    const prepare = h.db.prepare.bind(h.db)
    h.db.prepare = (sql: string) => {
      sqls.push(sql)
      return prepare(sql)
    }
    insertUpdate(h, 'n1', 1)
    insertUpdate(h, 'n2', 1)

    await getCrdtManifestPage(h.db, USER, VAULT, '', 1)

    expect(sqls).toHaveLength(4)
    for (const sql of sqls) {
      const plan = h.raw
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'x')) as Array<{
        detail: string
      }>
      const tableReads = plan.map((row) => row.detail).filter((d) => /crdt_/.test(d))
      expect(tableReads.length).toBeGreaterThan(0)
      for (const detail of tableReads) {
        expect(detail).toMatch(/^SEARCH .*(INDEX|PRIMARY KEY)/)
      }
    }
  })
})
