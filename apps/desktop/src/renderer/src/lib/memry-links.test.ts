import { describe, it, expect } from 'vitest'
import { buildMemryHref, parseMemryHref, tabFromMemryHref } from './memry-links'

/**
 * This grammar is the contract between every surface that hands the user a
 * link to a vault item (agent-chat messages, spatial canvas element links) and
 * the tab system. It had no test while it lived in two diverging copies; these
 * lock the merged behaviour before any new caller leans on it.
 */
describe('parseMemryHref', () => {
  it.each([
    ['memry://note/abc', { kind: 'note', id: 'abc', label: null }],
    ['memry://file/pdf-1', { kind: 'file', id: 'pdf-1', label: null }],
    ['memry://task/t1', { kind: 'task', id: 't1', label: null }],
    ['memry://inbox/i1', { kind: 'inbox', id: 'i1', label: null }],
    ['memry://journal/2026-08-17', { kind: 'journal', id: '2026-08-17', label: null }],
    ['memry://project/p1', { kind: 'project', id: 'p1', label: null }],
    ['memry://folder/Work%2FNotes', { kind: 'folder', id: 'Work/Notes', label: null }]
  ])('parses %s', (href, expected) => {
    expect(parseMemryHref(href)).toEqual(expected)
  })

  it('parses a calendar event with its focus date', () => {
    expect(parseMemryHref('memry://calendar/event/e1?date=2026-08-17')).toEqual({
      kind: 'calendar_event',
      id: 'e1',
      date: '2026-08-17',
      label: null
    })
  })

  it('reports a dateless calendar event rather than inventing a date', () => {
    expect(parseMemryHref('memry://calendar/event/e1')).toEqual({
      kind: 'calendar_event',
      id: 'e1',
      date: null,
      label: null
    })
  })

  it.each([
    ['a non-memry scheme', 'https://example.com/note/abc'],
    ['a syntactically invalid url', 'memry//note/abc'],
    ['an unknown host', 'memry://widget/abc'],
    ['an empty id', 'memry://note/'],
    ['a calendar path that is not an event', 'memry://calendar/day/2026-08-17'],
    ['a calendar event with no id', 'memry://calendar/event/']
  ])('rejects %s', (_label, href) => {
    expect(parseMemryHref(href)).toBeNull()
  })
})

describe('buildMemryHref', () => {
  it('round-trips every simple kind through the parser', () => {
    for (const kind of ['note', 'file', 'task', 'inbox', 'journal', 'project'] as const) {
      const href = buildMemryHref({ kind, id: 'x1' })
      expect(href).not.toBeNull()
      expect(parseMemryHref(href as string)).toEqual({ kind, id: 'x1', label: null })
    }
  })

  it('escapes a folder path so the slash survives the round trip', () => {
    const href = buildMemryHref({ kind: 'folder', id: 'Work/Notes' })
    expect(href).toBe('memry://folder/Work%2FNotes')
    expect(parseMemryHref(href as string)).toEqual({
      kind: 'folder',
      id: 'Work/Notes',
      label: null
    })
  })

  it('round-trips a calendar event with its date', () => {
    const href = buildMemryHref({ kind: 'calendar_event', id: 'e1', date: '2026-08-17' })
    expect(parseMemryHref(href as string)).toEqual({
      kind: 'calendar_event',
      id: 'e1',
      date: '2026-08-17',
      label: null
    })
  })

  it('refuses to build a dateless calendar link, because it could not open', () => {
    expect(buildMemryHref({ kind: 'calendar_event', id: 'e1' })).toBeNull()
  })

  it('refuses an empty id', () => {
    expect(buildMemryHref({ kind: 'note', id: '' })).toBeNull()
  })

  it('carries a title as a display label, escaped', () => {
    const href = buildMemryHref({ kind: 'note', id: 'n1', label: 'memrynote Launch' })
    expect(href).toBe('memry://note/n1?label=memrynote+Launch')
    expect(parseMemryHref(href as string)).toEqual({
      kind: 'note',
      id: 'n1',
      label: 'memrynote Launch'
    })
  })

  it('keeps the date and the label side by side for an event', () => {
    const href = buildMemryHref({
      kind: 'calendar_event',
      id: 'e1',
      date: '2026-08-17',
      label: 'Standup'
    })
    expect(parseMemryHref(href as string)).toEqual({
      kind: 'calendar_event',
      id: 'e1',
      date: '2026-08-17',
      label: 'Standup'
    })
  })

  it('omits the label entirely when there is none, so old links stay byte-identical', () => {
    expect(buildMemryHref({ kind: 'note', id: 'n1' })).toBe('memry://note/n1')
    expect(buildMemryHref({ kind: 'note', id: 'n1', label: '' })).toBe('memry://note/n1')
  })
})

describe('tabFromMemryHref', () => {
  it('opens a note in its own tab, titled by the caller', () => {
    expect(tabFromMemryHref('memry://note/n1', { title: 'Roadmap' })).toMatchObject({
      type: 'note',
      title: 'Roadmap',
      path: '/note/n1',
      entityId: 'n1'
    })
  })

  it('falls back to a generic note title', () => {
    expect(tabFromMemryHref('memry://note/n1')).toMatchObject({ title: 'Note' })
  })

  it("titles a tab from the link's own label when the caller has none", () => {
    expect(tabFromMemryHref('memry://note/n1?label=Roadmap')).toMatchObject({ title: 'Roadmap' })
  })

  it('prefers a caller-supplied title over the stored label, which can be stale', () => {
    expect(
      tabFromMemryHref('memry://note/n1?label=Old%20name', { title: 'New name' })
    ).toMatchObject({ title: 'New name' })
  })

  it('opens a filed binary in the file viewer, never the markdown editor', () => {
    expect(tabFromMemryHref('memry://file/f1', { title: 'Spec.pdf' })).toMatchObject({
      type: 'file',
      title: 'Spec.pdf',
      path: '/file/f1',
      entityId: 'f1'
    })
  })

  it('opens a task as the Tasks view with the task drawer requested', () => {
    expect(tabFromMemryHref('memry://task/t1')).toMatchObject({
      type: 'tasks',
      path: '/tasks',
      viewState: { openTaskId: 't1' }
    })
  })

  it('stamps the focus token it was given so a repeat click re-fires focus', () => {
    expect(tabFromMemryHref('memry://inbox/i1', { now: 1234 })).toMatchObject({
      type: 'inbox',
      viewState: { focusInboxItemId: 'i1', focusedAt: 1234 }
    })
  })

  it('defaults the focus token to a stable value rather than reading the clock', () => {
    expect(tabFromMemryHref('memry://inbox/i1')).toEqual(tabFromMemryHref('memry://inbox/i1'))
  })

  it('opens a journal day by date', () => {
    expect(tabFromMemryHref('memry://journal/2026-08-17')).toMatchObject({
      type: 'journal',
      path: '/journal/2026-08-17',
      viewState: { date: '2026-08-17' }
    })
  })

  it('encodes a folder path into its route', () => {
    expect(tabFromMemryHref('memry://folder/Work%2FNotes')).toMatchObject({
      type: 'folder',
      path: '/folder/Work%2FNotes',
      entityId: 'Work/Notes'
    })
  })

  it('focuses the calendar on the event day', () => {
    expect(
      tabFromMemryHref('memry://calendar/event/e1?date=2026-08-17', { now: 99 })
    ).toMatchObject({
      type: 'calendar',
      path: '/calendar',
      viewState: { focusCalendarEventId: 'e1', focusDate: '2026-08-17', focusedAt: 99 }
    })
  })

  it('refuses a dateless calendar event instead of jumping the user to today', () => {
    expect(tabFromMemryHref('memry://calendar/event/e1')).toBeNull()
  })

  it('returns null for anything the grammar rejects', () => {
    expect(tabFromMemryHref('https://example.com')).toBeNull()
  })

  it('never marks an opened tab as pinned, modified, preview or deleted', () => {
    expect(tabFromMemryHref('memry://note/n1')).toMatchObject({
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
  })
})
