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
  it('lists blocks before notes and strips a trailing anchor from block text', () => {
    const items = buildPortalPickerList({
      notes: [note('n1', 'Cell Biology')],
      blocks: [block('n2', 'b1', 'Chloroplast ^chl-7f2a', 'chl-7f2a')],
      hostNoteId: 'host',
      ancestry: []
    })
    expect(items.map((i) => [i.kind, i.title])).toEqual([
      ['block', 'Chloroplast'],
      ['note', 'Cell Biology']
    ])
    expect(items[1]).toMatchObject({ folder: 'Lectures / Biology' })
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
    expect(items.map((i) => ('noteId' in i ? i.noteId : ''))).toEqual(['ok'])
  })

  it('still offers a block of the host note, but not a block of a portal ancestor', () => {
    const items = buildPortalPickerList({
      notes: [],
      blocks: [block('host', 'b1'), block('anc', 'b2'), block('other', 'b3')],
      hostNoteId: 'host',
      ancestry: ['anc']
    })
    expect(items.map((i) => ('noteId' in i ? i.noteId : ''))).toEqual(['host', 'other'])
  })
})

describe('host note self-references', () => {
  const run = (blocks: ReturnType<typeof block>[]) =>
    buildPortalPickerList({
      notes: [],
      blocks,
      hostNoteId: 'host',
      ancestry: [],
      query: 'test',
      activeBlockId: 'typing'
    }).flatMap((i) => (i.kind === 'block' ? [i.blockId] : []))

  it('never offers the block the query is typed in', () => {
    expect(run([block('host', 'typing', '((test'), block('host', 'other', 'a test line')])).toEqual(
      ['other']
    )
  })

  it('drops any host block still holding a half-typed `((` line, keeps the rest', () => {
    expect(
      run([
        block('host', 'stale', '((test more'),
        block('host', 'keep', 'test'),
        block('other', 'foreign', '((test in another note')
      ])
    ).toEqual(['keep', 'foreign'])
  })
})

describe('create row', () => {
  it('closes the list with the trimmed query, and is absent for an empty one', () => {
    const base = { notes: [note('n1')], blocks: [], hostNoteId: 'host', ancestry: [] }
    const items = buildPortalPickerList({ ...base, query: '  Plan  ' })
    expect(items.at(-1)).toEqual({ kind: 'create', key: 'create', title: 'Plan' })
    expect(buildPortalPickerList({ ...base, query: ' ' }).some((i) => i.kind === 'create')).toBe(
      false
    )
  })
})

describe('folderLabel', () => {
  it('is empty for a note at the vault root', () => {
    expect(folderLabel('Inbox.md')).toBe('')
  })
})
