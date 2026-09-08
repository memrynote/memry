import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  openTestVault,
  seedNote,
  type TestVault
} from '@/features/notes/__tests__/vault-db-harness'
import { createQuickNoteRepo } from './quick-note-repo'

describe('quick note SQLite search', () => {
  let vault: TestVault

  beforeEach(() => {
    vault = openTestVault()
  })
  afterEach(() => vault.close())

  it('finds an exact title outside the newest 400 notes', async () => {
    seedNote(vault, { id: 'old-target', title: 'Needle note' })
    await vault.db.runAsync('UPDATE sync_items SET updated_at = 1 WHERE id = ?', ['old-target'])
    for (let index = 0; index < 401; index += 1) {
      seedNote(vault, { id: `recent-${index}`, title: `Recent ${index}` })
    }

    const results = await createQuickNoteRepo(vault.db).search('Needle note')

    expect(results.map((note) => note.id)).toEqual(['old-target'])
    expect(results[0]?.exactTitle).toBe(true)
  })
})
