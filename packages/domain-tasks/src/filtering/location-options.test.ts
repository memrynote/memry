import { describe, expect, it } from 'vitest'

import { buildTaskLocationOptions, type LocationTask } from './location-options.ts'
import type { TaskNoteInfo } from './types.ts'

const task = (overrides: Partial<LocationTask> & { id: string }): LocationTask => ({
  parentId: null,
  sourceNoteId: null,
  linkedNoteIds: [],
  ...overrides
})

const noteIndex = new Map<string, TaskNoteInfo>(
  [
    { id: 'roof', title: 'Roof', folderPath: 'Infra/House/Stage 1' },
    { id: 'brief', title: 'Brief', folderPath: 'Infra/House' },
    { id: 'inbox', title: 'Inbox', folderPath: '' },
    { id: 'empty', title: 'Empty', folderPath: 'Infra' }
  ].map((note) => [note.id, note])
)

const tasks = [
  task({ id: 't1', sourceNoteId: 'roof' }),
  task({ id: 't2', sourceNoteId: 'roof' }),
  task({ id: 't3', sourceNoteId: 'brief', linkedNoteIds: ['roof'] }),
  task({ id: 'sub', sourceNoteId: 'brief', parentId: 't3' }),
  task({ id: 't4', sourceNoteId: 'inbox' })
]

const none = { folderPaths: [], noteIds: [] }

describe('buildTaskLocationOptions', () => {
  it('lists places with tasks as a tree, notes before subfolders, counting top-level tasks once', () => {
    const rows = buildTaskLocationOptions(tasks, noteIndex, none, '').map(
      (row) => `${'  '.repeat(row.depth)}${row.kind}:${row.label}=${row.count}`
    )

    expect(rows).toEqual([
      'note:Inbox=1',
      'folder:Infra=3',
      '  folder:House=3',
      '    note:Brief=1',
      '    folder:Stage 1=3',
      '      note:Roof=3'
    ])
  })

  it('keeps a selected place listed after its tasks are gone', () => {
    const rows = buildTaskLocationOptions(
      [],
      noteIndex,
      { folderPaths: ['Infra/House'], noteIds: ['empty'] },
      ''
    )
    expect(rows.map((row) => `${row.kind}:${row.value}=${row.count}`)).toEqual([
      'folder:Infra=0',
      'note:empty=0',
      'folder:Infra/House=0'
    ])
  })

  it('flattens to name matches with their parent path while searching', () => {
    const rows = buildTaskLocationOptions(tasks, noteIndex, none, 'stage')
    expect(rows).toEqual([
      {
        kind: 'folder',
        value: 'Infra/House/Stage 1',
        label: 'Stage 1',
        context: 'Infra/House',
        depth: 0,
        count: 3
      }
    ])
  })
})
