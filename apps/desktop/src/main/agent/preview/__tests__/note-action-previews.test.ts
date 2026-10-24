import { describe, expect, it } from 'vitest'

import type { StoredNote } from '../../mcp/tools/handles'
import { NOTE_ACTION_PREVIEW_BUILDERS } from '../note-action-previews'

const notes = new Map([
  ['a', { title: 'Alpha', folder_path: 'Inbox' }],
  ['b', { title: 'Beta', folder_path: 'Inbox' }],
  ['c', { title: 'Gamma', folder_path: 'Work' }],
  ['d', { title: 'Delta', folder_path: 'Inbox' }]
])

const handles = {
  notes: {
    stored: async (id: string): Promise<StoredNote | null> => {
      const note = notes.get(id)
      return note
        ? { id, ...note, tags: [], properties: {}, body_bytes: 0, body_sha256: null }
        : null
    }
  }
}

describe('bulk note previews', () => {
  it('names the first notes, counts the rest and lists the tag changes', async () => {
    const preview = await NOTE_ACTION_PREVIEW_BUILDERS.vault_bulk_tag_notes(
      { ids: ['a', 'b', 'c', 'd'], add: ['x', 'y'], remove: ['z'] },
      handles
    )

    expect(preview.item.title).toBe('Alpha, Beta, Gamma +1')
    expect(preview.fields).toEqual([
      { key: 'notes', before: null, after: '4' },
      { key: 'add', before: null, after: 'x, y' },
      { key: 'remove', before: null, after: 'z' }
    ])
  })

  it('shows the source folder only when every note shares it', async () => {
    const same = await NOTE_ACTION_PREVIEW_BUILDERS.vault_bulk_move_notes(
      { ids: ['a', 'b'], folder_path: 'Archive' },
      handles
    )
    const mixed = await NOTE_ACTION_PREVIEW_BUILDERS.vault_bulk_move_notes(
      { ids: ['a', 'c'], folder_path: 'Archive' },
      handles
    )

    expect(same.fields.find((row) => row.key === 'folder')).toEqual({
      key: 'folder',
      before: 'Inbox',
      after: 'Archive'
    })
    expect(mixed.fields.find((row) => row.key === 'folder')?.before).toBeNull()
  })

  it('previews an insert with the linked title spelled as a wiki-link', async () => {
    const preview = await NOTE_ACTION_PREVIEW_BUILDERS.vault_insert_at_cursor(
      {
        id: 'a',
        items: [
          { type: 'text', text: 'See' },
          { type: 'note_link', note_id: 'b' }
        ]
      },
      handles
    )

    expect(preview.item.title).toBe('Alpha')
    expect(preview.fields).toEqual([{ key: 'insert', before: null, after: 'See [[Beta]]' }])
  })
})
