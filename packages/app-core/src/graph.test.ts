import assert from 'node:assert/strict'
import test from 'node:test'

import { createGraphService } from './graph.ts'
import type { NoteRecord, NotesService } from './service-types.ts'
import type { TasksService } from './tasks.ts'

function note(id: string, title: string, content: string): NoteRecord {
  return {
    id,
    path: `${title}.md`,
    title,
    content,
    tags: [],
    properties: {},
    emoji: null,
    localOnly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    journalDate: null,
    wordCount: 0,
    snippet: ''
  }
}

function graphOf(notes: NoteRecord[]) {
  const notesService = {
    list: async (options?: { journalOnly?: boolean }) => (options?.journalOnly ? [] : notes)
  } as unknown as NotesService
  const tasksService = {
    list: async () => [],
    projects: { list: async () => [] }
  } as unknown as TasksService
  return createGraphService({ notes: notesService, tasks: tasksService })
}

test('graph: link syntax inside code draws no node, links in comments still do', async () => {
  const content = [
    'Write `[[Inline Example]]` to link a note.',
    '```',
    '[[Fenced Example]]',
    '```',
    '<!-- [[Hidden Target]] -->',
    'See [[Guide]] and [[Missing]].'
  ].join('\n')
  const data = await graphOf([note('n1', 'Docs', content), note('n2', 'Guide', '')]).data()

  assert.deepEqual(
    data.nodes.filter((node) => node.isUnresolved).map((node) => node.label),
    ['Hidden Target', 'Missing']
  )
  assert.deepEqual(
    data.edges.map((edge) => edge.target),
    ['ghost:Hidden Target', 'n2', 'ghost:Missing']
  )
})

test('graph: fenced code in a CRLF note draws no node', async () => {
  const content = ['```', '[[Fenced Example]]', '```', 'See [[Missing]].'].join('\r\n')
  const data = await graphOf([note('n1', 'Docs', content)]).data()

  assert.deepEqual(
    data.nodes.filter((node) => node.isUnresolved).map((node) => node.label),
    ['Missing']
  )
})
