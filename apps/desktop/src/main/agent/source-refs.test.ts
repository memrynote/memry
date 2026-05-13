import { describe, expect, it } from 'vitest'

import { decorateToolResultWithAgentSources, extractAgentSourceRefs } from './source-refs'

describe('Agent source refs', () => {
  it('extracts every note from note list results', () => {
    const refs = extractAgentSourceRefs('vault_search_notes', {}, [
      { id: 'note-1', title: 'Movies', snippet: 'A', folder_path: null },
      { id: 'note-2', title: 'Movie Ideas', snippet: 'B', folder_path: 'Notes' }
    ])

    expect(refs).toEqual([
      { kind: 'note', id: 'note-1', title: 'Movies', href: 'memry://note/note-1' },
      { kind: 'note', id: 'note-2', title: 'Movie Ideas', href: 'memry://note/note-2' }
    ])
  })

  it('uses create args to source newly created notes', () => {
    const refs = extractAgentSourceRefs(
      'vault_create_note',
      { title: 'Movies', content_markdown: '' },
      { id: 'note-1' }
    )

    expect(refs).toEqual([
      { kind: 'note', id: 'note-1', title: 'Movies', href: 'memry://note/note-1' }
    ])
  })

  it('extracts calendar event refs from desktop calendar range results', () => {
    const refs = extractAgentSourceRefs(
      'vault_desktop_read',
      { operation: 'calendar.getRange', args: [] },
      {
        items: [
          {
            sourceType: 'event',
            sourceId: 'event-1',
            title: 'Planning',
            startAt: '2026-05-13T09:00:00.000Z'
          },
          {
            sourceType: 'task',
            sourceId: 'task-1',
            title: 'Not a calendar event',
            startAt: '2026-05-13T10:00:00.000Z'
          }
        ]
      }
    )

    expect(refs).toEqual([
      {
        kind: 'calendar_event',
        id: 'event-1',
        title: 'Planning',
        href: 'memry://calendar/event/event-1?date=2026-05-13'
      },
      {
        kind: 'task',
        id: 'task-1',
        title: 'Not a calendar event',
        href: 'memry://task/task-1'
      }
    ])
  })

  it('decorates MCP tool results with source refs without wrapping arrays', () => {
    const decorated = decorateToolResultWithAgentSources('vault_search_notes', {}, [
      { id: 'note-1', title: 'Movies', snippet: 'A', folder_path: null }
    ])

    expect(decorated).toEqual([
      {
        id: 'note-1',
        title: 'Movies',
        snippet: 'A',
        folder_path: null,
        href: 'memry://note/note-1',
        source_ref: {
          kind: 'note',
          id: 'note-1',
          title: 'Movies',
          href: 'memry://note/note-1'
        }
      }
    ])
  })
})
