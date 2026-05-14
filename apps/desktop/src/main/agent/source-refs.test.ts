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

  it('preserves item icon metadata for note, inbox, and calendar refs', () => {
    const refs = extractAgentSourceRefs(
      'vault_desktop_read',
      { operation: 'calendar.getRange', args: [] },
      {
        items: [
          {
            sourceType: 'event',
            sourceId: 'event-1',
            title: 'Planning',
            startAt: '2026-05-13T09:00:00.000Z',
            visualType: 'event'
          },
          {
            sourceType: 'inbox_snooze',
            sourceId: 'inbox-1',
            title: 'Read later',
            startAt: '2026-05-13T10:00:00.000Z',
            visualType: 'snooze'
          }
        ]
      }
    )

    expect(refs).toEqual([
      {
        kind: 'calendar_event',
        id: 'event-1',
        title: 'Planning',
        href: 'memry://calendar/event/event-1?date=2026-05-13',
        visualType: 'event'
      },
      {
        kind: 'inbox',
        id: 'inbox-1',
        title: 'Read later',
        href: 'memry://inbox/inbox-1',
        visualType: 'snooze'
      }
    ])

    expect(
      extractAgentSourceRefs('vault_search_notes', {}, [
        { id: 'note-1', title: 'Movies', icon: '🎬' }
      ])
    ).toEqual([
      { kind: 'note', id: 'note-1', title: 'Movies', href: 'memry://note/note-1', icon: '🎬' }
    ])

    expect(
      extractAgentSourceRefs(
        'vault_read_note',
        {},
        {
          id: 'note-2',
          title: 'Books',
          emoji: '📚'
        }
      )
    ).toEqual([
      { kind: 'note', id: 'note-2', title: 'Books', href: 'memry://note/note-2', icon: '📚' }
    ])

    expect(
      extractAgentSourceRefs('vault_list_inbox_items', {}, [
        { id: 'inbox-2', title: 'Spec PDF', type: 'pdf' },
        { id: 'inbox-3', title: 'Tweet', type: 'social', visual_type: 'twitter' },
        { id: 'inbox-4', title: 'Quote', type: 'clip' }
      ])
    ).toEqual([
      {
        kind: 'inbox',
        id: 'inbox-2',
        title: 'Spec PDF',
        href: 'memry://inbox/inbox-2',
        itemType: 'pdf'
      },
      {
        kind: 'inbox',
        id: 'inbox-3',
        title: 'Tweet',
        href: 'memry://inbox/inbox-3',
        itemType: 'social',
        visualType: 'twitter'
      },
      {
        kind: 'inbox',
        id: 'inbox-4',
        title: 'Quote',
        href: 'memry://inbox/inbox-4',
        itemType: 'clip',
        visualType: 'quote'
      }
    ])
  })

  it('extracts icon metadata from MCP content wrappers', () => {
    const noteResult = [
      {
        id: 'note-1',
        title: 'Movies',
        href: 'memry://note/note-1',
        source_ref: {
          kind: 'note',
          id: 'note-1',
          title: 'Movies',
          href: 'memry://note/note-1',
          icon: '🎬'
        }
      }
    ]
    const inboxResult = [
      {
        id: 'inbox-1',
        title: 'Tweet',
        type: 'social',
        visual_type: 'twitter',
        href: 'memry://inbox/inbox-1',
        source_ref: {
          kind: 'inbox',
          id: 'inbox-1',
          title: 'Tweet',
          href: 'memry://inbox/inbox-1',
          itemType: 'social',
          visualType: 'twitter'
        }
      }
    ]

    expect(
      extractAgentSourceRefs(
        'vault_search_notes',
        {},
        {
          content: [{ type: 'text', text: JSON.stringify(noteResult) }]
        }
      )
    ).toEqual([
      {
        kind: 'note',
        id: 'note-1',
        title: 'Movies',
        href: 'memry://note/note-1',
        icon: '🎬'
      }
    ])

    expect(
      extractAgentSourceRefs(
        'vault_list_inbox_items',
        {},
        {
          content: [{ type: 'text', text: JSON.stringify(inboxResult) }]
        }
      )
    ).toEqual([
      {
        kind: 'inbox',
        id: 'inbox-1',
        title: 'Tweet',
        href: 'memry://inbox/inbox-1',
        itemType: 'social',
        visualType: 'twitter'
      }
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
