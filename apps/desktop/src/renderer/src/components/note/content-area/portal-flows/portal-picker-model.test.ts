import { describe, expect, it } from 'vitest'
import {
  PICKER_BLOCK_LIMIT,
  PICKER_NOTE_LIMIT,
  buildPortalPickerList,
  folderLabel
} from './portal-picker-model'

const note = (id: string, title = id, path = `Lectures/Biology/${title}.md`) => ({
  noteId: id,
  title,
  path
})
const block = (
  noteId: string,
  blockId: string,
  text = `text ${blockId}`,
  anchor: string | null = null
) => ({
  noteId,
  noteTitle: `Title ${noteId}`,
  blockId,
  anchor,
  text
})

describe('buildPortalPickerList', () => {
  it('lists notes before blocks and strips a trailing anchor from block text', () => {
    const items = buildPortalPickerList({
      notes: [note('n1', 'Cell Biology')],
      blocks: [block('n2', 'b1', 'Chloroplast ^chl-7f2a', 'chl-7f2a')],
      hostNoteId: 'host',
      ancestry: []
    })
    expect(items.map((i) => [i.kind, i.title])).toEqual([
      ['note', 'Cell Biology'],
      ['block', 'Chloroplast']
    ])
    expect(items[0]).toMatchObject({ folder: 'Lectures / Biology' })
  })

  it('caps notes and blocks separately', () => {
    const items = buildPortalPickerList({
      notes: Array.from({ length: PICKER_NOTE_LIMIT + 10 }, (_, i) => note(`n${i}`)),
      blocks: Array.from({ length: 20 }, (_, i) => block('src', `b${i}`)),
      hostNoteId: 'host',
      ancestry: []
    })
    expect(items.filter((i) => i.kind === 'note')).toHaveLength(PICKER_NOTE_LIMIT)
    expect(items.filter((i) => i.kind === 'block')).toHaveLength(PICKER_BLOCK_LIMIT)
  })

  it('drops the host and its portal ancestors as whole notes', () => {
    const items = buildPortalPickerList({
      notes: [note('host', 'Host'), note('anc', 'Ancestor'), note('ok', 'Fine')],
      blocks: [],
      hostNoteId: 'host',
      ancestry: ['anc']
    })
    expect(items.map((i) => i.noteId)).toEqual(['ok'])
  })

  it('still offers a block of the host note, but not a block of a portal ancestor', () => {
    const items = buildPortalPickerList({
      notes: [],
      blocks: [block('host', 'b1'), block('anc', 'b2'), block('other', 'b3')],
      hostNoteId: 'host',
      ancestry: ['anc']
    })
    expect(items.map((i) => i.noteId)).toEqual(['host', 'other'])
  })
})

describe('folderLabel', () => {
  it('is empty for a note at the vault root', () => {
    expect(folderLabel('Inbox.md')).toBe('')
  })
})
