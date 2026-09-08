import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { duplicateNote } from '@/features/notes/note-ops'
import { openTestVault, seedNote, type TestVault } from './vault-db-harness'

describe('duplicateNote live editor body', () => {
  let vault: TestVault

  beforeEach(() => {
    vault = openTestVault()
  })
  afterEach(() => vault.close())

  it('uses an explicit live body instead of stale materialized markdown', async () => {
    seedNote(vault, { id: 'source', title: 'Source', markdown: 'stale body' })

    const copyId = await duplicateNote(vault.ctx, 'source', { body: 'live editor body' })

    expect(copyId).not.toBeNull()
    const body = await vault.db.getFirstAsync<{ markdown: string }>(
      'SELECT markdown FROM note_bodies WHERE item_id = ?',
      [copyId]
    )
    expect(body?.markdown).toBe('live editor body')
    expect(vault.outboxRows().at(-1)?.payload).toMatchObject({ content: 'live editor body' })
  })

  it('stores the live CRDT state for a lossless local copy', async () => {
    seedNote(vault, { id: 'source', title: 'Source', markdown: 'plain fallback' })
    const source = new Y.Doc()
    source.getText('content').insert(0, 'marked live body')
    const state = Y.encodeStateAsUpdate(source)

    const copyId = await duplicateNote(vault.ctx, 'source', {
      body: 'marked live body',
      crdtState: state
    })
    expect(copyId).not.toBeNull()

    const snapshot = await vault.db.getFirstAsync<{ snapshot: Uint8Array }>(
      'SELECT snapshot FROM yjs_snapshots WHERE doc_id = ?',
      [`local.${copyId}`]
    )
    expect(Array.from(snapshot?.snapshot ?? [])).toEqual(Array.from(state))
    const outbox = await vault.db.getFirstAsync<{ op: string; payload: Uint8Array }>(
      'SELECT op, payload FROM outbox WHERE item_id = ? AND op = ?',
      [copyId, 'crdt-update']
    )
    expect(outbox?.op).toBe('crdt-update')
    expect(Array.from(outbox?.payload ?? [])).toEqual(Array.from(state))
    expect(
      await vault.db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
        `seed.${copyId}`
      ])
    ).toBeNull()
    source.destroy()
  })
})
