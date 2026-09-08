import { describe, expect, it } from 'vitest'

import { openTestVault } from '@/features/notes/__tests__/vault-db-harness'
import { createQuickNoteRepo, quickNotesFromRows, type QuickNoteRow } from './quick-note-repo'

function row(id: string, title: string, updatedAt: number, folderPath?: string): QuickNoteRow {
  return {
    id,
    payload: JSON.stringify({ title, ...(folderPath ? { folderPath } : {}) }),
    updated_at: updatedAt
  }
}

describe('quickNotesFromRows', () => {
  it('returns the most recently updated notes for an empty query', () => {
    const notes = quickNotesFromRows(
      [row('old', 'Old note', 10), row('new', 'New note', 30), row('middle', 'Middle', 20)],
      '',
      2
    )

    expect(notes.map((note) => note.id)).toEqual(['new', 'middle'])
    expect(notes.every((note) => note.exactTitle === false)).toBe(true)
  })

  it('ranks exact title, then prefixes, then substrings with stable recency ties', () => {
    const notes = quickNotesFromRows(
      [
        row('substring', 'Local notes on governing', 50),
        row('prefix-old', 'Governing Together', 20),
        row('exact', 'Governing', 10),
        row('prefix-new', 'Governing the Commons', 40),
        row('miss', 'Unrelated', 100)
      ],
      'governing'
    )

    expect(notes.map((note) => note.id)).toEqual(['exact', 'prefix-new', 'prefix-old', 'substring'])
    expect(notes[0]?.exactTitle).toBe(true)
  })

  it('matches titles case-insensitively and preserves display data', () => {
    const notes = quickNotesFromRows(
      [row('n1', 'GOVERNING', 10, 'Books/Institutions')],
      'governing'
    )

    expect(notes).toEqual([
      {
        id: 'n1',
        title: 'GOVERNING',
        folderPath: 'Books/Institutions',
        updatedAt: 10,
        exactTitle: true
      }
    ])
  })

  it('matches locale-sensitive Unicode titles case-insensitively through the database adapter', async () => {
    const vault = openTestVault()
    try {
      await vault.db.runAsync(
        `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
         VALUES (?, 'note', ?, ?, 'full', ?)`,
        ['unicode', 'vault-1', 10, JSON.stringify({ title: 'İstanbul' })]
      )

      const notes = await createQuickNoteRepo(vault.db).search('istanbul')

      expect(notes.map((note) => note.title)).toEqual(['İstanbul'])
    } finally {
      vault.close()
    }
  })

  it('skips malformed payloads and uses Untitled for a missing title', () => {
    const notes = quickNotesFromRows(
      [
        { id: 'broken', payload: '{', updated_at: 30 },
        { id: 'untitled', payload: '{}', updated_at: 20 },
        { id: 'null', payload: null, updated_at: 10 }
      ],
      ''
    )

    expect(notes.map((note) => [note.id, note.title])).toEqual([['untitled', 'Untitled']])
  })

  it('ranks the newest candidate rows before applying the result cap', async () => {
    const vault = openTestVault()
    try {
      await vault.db.runAsync(
        `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
         VALUES (?, 'note', ?, ?, 'full', ?)`,
        ['exact', 'vault-1', 1000, JSON.stringify({ title: 'Needle' })]
      )
      for (let index = 0; index < 400; index += 1) {
        await vault.db.runAsync(
          `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
           VALUES (?, 'note', ?, ?, 'full', ?)`,
          [
            `substring-${index}`,
            'vault-1',
            index + 2,
            JSON.stringify({ title: `Notes containing needle ${index}` })
          ]
        )
      }

      const notes = await createQuickNoteRepo(vault.db).search('needle')

      expect(notes[0]?.id).toBe('exact')
      expect(notes[0]?.exactTitle).toBe(true)
    } finally {
      vault.close()
    }
  })

  it('does not let malformed JSON abort a database search', async () => {
    const vault = openTestVault()
    try {
      await vault.db.runAsync(
        `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
         VALUES
           ('broken', 'note', 'vault-1', 2, 'full', '{'),
           ('valid', 'note', 'vault-1', 1, 'full', '{"title":"Needle"}')`
      )

      const notes = await createQuickNoteRepo(vault.db).search('needle')

      expect(notes.map((note) => note.id)).toEqual(['valid'])
    } finally {
      vault.close()
    }
  })
})
