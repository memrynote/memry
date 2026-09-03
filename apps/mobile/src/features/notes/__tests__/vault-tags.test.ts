import { afterEach, describe, expect, it } from 'vitest'

import { readVaultTags } from '../note-ops'
import { openTestVault, type TestVault } from './vault-db-harness'

let vault: TestVault | null = null

afterEach(() => {
  vault?.close()
  vault = null
})

async function insert(
  db: TestVault['db'],
  input: { id: string; type: 'note' | 'journal'; payload: string; deletedAt?: number }
): Promise<void> {
  await db.runAsync(
    `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload, deleted_at)
     VALUES (?, ?, 'vault-1', 1, 'full', ?, ?)`,
    [input.id, input.type, input.payload, input.deletedAt ?? null]
  )
}

describe('readVaultTags', () => {
  it('dedupes case-insensitively, keeps the first casing, spans journals, and sorts', async () => {
    vault = openTestVault()
    await insert(vault.db, {
      id: 'n1',
      type: 'note',
      payload: JSON.stringify({ tags: ['Commons', 'roadmap'] })
    })
    await insert(vault.db, {
      id: 'n2',
      type: 'note',
      // A later row's differing case must not win.
      payload: JSON.stringify({ tags: ['commons', 'ROADMAP'] })
    })
    await insert(vault.db, {
      id: 'j1',
      type: 'journal',
      payload: JSON.stringify({ tags: ['daily'] })
    })

    await expect(readVaultTags(vault.db)).resolves.toEqual(['Commons', 'daily', 'roadmap'])
  })

  it('skips deleted rows and unparseable payloads without throwing', async () => {
    vault = openTestVault()
    await insert(vault.db, {
      id: 'live',
      type: 'note',
      payload: JSON.stringify({ tags: ['kept'] })
    })
    await insert(vault.db, {
      id: 'gone',
      type: 'note',
      payload: JSON.stringify({ tags: ['dropped'] }),
      deletedAt: 2
    })
    await insert(vault.db, { id: 'broken', type: 'note', payload: '{not json' })
    await insert(vault.db, { id: 'untagged', type: 'note', payload: JSON.stringify({ tags: 7 }) })

    await expect(readVaultTags(vault.db)).resolves.toEqual(['kept'])
  })
})
