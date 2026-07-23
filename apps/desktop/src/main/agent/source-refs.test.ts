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

  it('extracts refs for folder, task, project, journal, and inbox tool variants', () => {
    expect(
      extractAgentSourceRefs('vault_list_folder', {}, [
        { kind: 'folder', path: 'Areas/Work', name: 'Work' },
        { kind: 'note', id: 'note-1', name: 'Inbox Note', emoji: '📝' },
        { kind: 'asset', id: 'ignored', name: 'Ignored' }
      ])
    ).toEqual([
      { kind: 'folder', id: 'Areas/Work', title: 'Work', href: 'memry://folder/Areas%2FWork' },
      {
        kind: 'note',
        id: 'note-1',
        title: 'Inbox Note',
        href: 'memry://note/note-1',
        icon: '📝'
      }
    ])

    expect(
      extractAgentSourceRefs(
        'mcp__memry__vault_get_task',
        {},
        {
          sourceId: 'task-1',
          name: 'Ship snooze'
        }
      )
    ).toEqual([{ kind: 'task', id: 'task-1', title: 'Ship snooze', href: 'memry://task/task-1' }])

    expect(
      extractAgentSourceRefs(
        'vault_create_project',
        { name: 'Launch', id: 'project-from-args' },
        {}
      )
    ).toEqual([
      {
        kind: 'project',
        id: 'project-from-args',
        title: 'Launch',
        href: 'memry://project/project-from-args'
      }
    ])

    expect(
      extractAgentSourceRefs('vault_create_journal_entry', { date: '2026-05-14' }, {})
    ).toEqual([
      {
        kind: 'journal',
        id: '2026-05-14',
        title: '2026-05-14',
        href: 'memry://journal/2026-05-14'
      }
    ])

    expect(
      extractAgentSourceRefs(
        'vault_snooze_inbox_item',
        { id: 'inbox-1' },
        { title: 'Read the spec' }
      )
    ).toEqual([
      { kind: 'inbox', id: 'inbox-1', title: 'Read the spec', href: 'memry://inbox/inbox-1' }
    ])
  })

  it('extracts desktop calendar refs for direct event operations', () => {
    expect(
      extractAgentSourceRefs(
        'vault_desktop_read',
        { operation: 'calendar.listEvents', args: [] },
        {
          events: [{ eventId: 'event-1', title: 'Demo', startAt: '2026-05-14T12:30:00.000Z' }]
        }
      )
    ).toEqual([
      {
        kind: 'calendar_event',
        id: 'event-1',
        title: 'Demo',
        href: 'memry://calendar/event/event-1?date=2026-05-14'
      }
    ])

    expect(
      extractAgentSourceRefs(
        'vault_desktop_read',
        { operation: 'calendar.getEvent', args: [] },
        { id: 'event-2', title: 'Follow up', startAt: '2026-05-15' }
      )
    ).toEqual([
      {
        kind: 'calendar_event',
        id: 'event-2',
        title: 'Follow up',
        href: 'memry://calendar/event/event-2?date=2026-05-15'
      }
    ])

    expect(
      extractAgentSourceRefs(
        'vault_desktop_write',
        {
          operation: 'calendar.createEvent',
          args: [{ id: 'event-from-args', title: 'From args', startAt: '2026-05-16' }]
        },
        {}
      )
    ).toEqual([
      {
        kind: 'calendar_event',
        id: 'event-from-args',
        title: 'From args',
        href: 'memry://calendar/event/event-from-args?date=2026-05-16'
      }
    ])

    // calendar.promoteExternalEvent is no longer an agent operation
    // (Google Workspace Limited Use), so it yields no refs.
    expect(
      extractAgentSourceRefs(
        'vault_desktop_write',
        { operation: 'calendar.promoteExternalEvent', args: [] },
        { event: { id: 'event-3', title: 'Promoted', startAt: 'not-a-date' } }
      )
    ).toEqual([])
  })

  it('decorates object results, nested collections, and existing refs', () => {
    const decorated = decorateToolResultWithAgentSources(
      'vault_get_task',
      {},
      {
        id: 'task-1',
        title: 'One',
        items: [{ id: 'task-1', title: 'One' }],
        events: [{ id: 'task-1', title: 'One' }],
        event: { id: 'task-1', title: 'One' }
      }
    )

    const sourceRef = {
      kind: 'task',
      id: 'task-1',
      title: 'One',
      href: 'memry://task/task-1'
    }

    expect(decorated).toEqual({
      id: 'task-1',
      title: 'One',
      href: 'memry://task/task-1',
      source_ref: sourceRef,
      items: [{ id: 'task-1', title: 'One', href: 'memry://task/task-1', source_ref: sourceRef }],
      events: [{ id: 'task-1', title: 'One', href: 'memry://task/task-1', source_ref: sourceRef }],
      event: { id: 'task-1', title: 'One', href: 'memry://task/task-1', source_ref: sourceRef },
      sources: [sourceRef]
    })

    expect(
      extractAgentSourceRefs('vault_search_notes', {}, [
        {
          source_ref: {
            kind: 'unknown',
            id: 'ignored',
            title: 'Ignored',
            href: 'memry://unknown/ignored'
          }
        },
        {
          source_ref: {
            kind: 'folder',
            id: 'Inbox',
            title: 'Inbox',
            href: 'memry://folder/Inbox'
          }
        }
      ])
    ).toEqual([{ kind: 'folder', id: 'Inbox', title: 'Inbox', href: 'memry://folder/Inbox' }])
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
