import { describe, expect, it, vi } from 'vitest'

import type { VaultServiceHandles } from '../../mcp/tools/handles'
import { WRITE_TOOL_NAMES } from '../../mcp/tools/schemas'
import { buildChangePreview } from '../build-change-preview'
import { buildPreviewDiffResponse } from '../index'

function handles(overrides: Record<string, unknown> = {}): VaultServiceHandles {
  const base = {
    notes: {
      read: vi.fn(async () => ({
        id: 'note-1',
        title: 'Q4 planning',
        content_markdown: 'Hiring stays paused until the next board review.',
        tags: ['work', 'planning'],
        folder_path: 'Work/Planning',
        frontmatter: {},
        file_type: 'markdown'
      }))
    },
    folders: {
      list: vi.fn(async () => [
        { kind: 'note', id: 'n1', name: 'a', path: 'Work/a' },
        { kind: 'note', id: 'n2', name: 'b', path: 'Work/b' },
        { kind: 'folder', id: 'f1', name: 'sub', path: 'Work/sub' }
      ])
    },
    tasks: {
      get: vi.fn(async () => ({
        id: 'task-1',
        title: 'Ship the preview API',
        projectId: 'project-1',
        statusId: 'todo',
        parentId: null,
        dueDate: '2026-10-12',
        dueTime: null,
        priority: 0,
        description: 'Some detail worth keeping.',
        tags: ['work'],
        completedAt: null,
        archivedAt: null,
        position: 3
      }))
    },
    projects: {
      get: vi.fn(async () => ({
        id: 'project-1',
        name: 'Memry',
        description: null,
        color: '#f97316',
        icon: null,
        archivedAt: null
      })),
      list: vi.fn(async () => [
        {
          id: 'project-1',
          name: 'Memry',
          status: null,
          task_count: 4,
          icon: null,
          home_note_id: null,
          linked_counts: { notes: 2, files: 3, events: 1 }
        }
      ])
    },
    journal: {
      getByDate: vi.fn(async () => ({
        id: 'journal-1',
        date: '2026-09-18',
        content_markdown: 'Slept badly. The sync retry loop is still wrong.'
      }))
    },
    inbox: {
      get: vi.fn(async () => ({
        id: 'inbox-1',
        title: 'Sync retry backoff thread',
        content: 'Long capture body.',
        source: 'clip',
        tags: ['inbox'],
        archivedAt: null,
        snoozedUntil: null,
        snoozeReason: null
      }))
    },
    canvas: {
      read: vi.fn(async () => ({
        id: 'canvas-1',
        title: 'Plan',
        created_at: 0,
        updated_at: 0,
        items: [{ entity_type: 'note', entity_id: 'note-1', title: 'Q4', missing: false }],
        texts: [],
        element_count: 1,
        texts_truncated: false
      }))
    }
  }
  return { ...base, ...overrides } as unknown as VaultServiceHandles
}

describe('buildChangePreview', () => {
  /**
   * The gate promises a preview for every write tool, so a tool with no builder
   * is a card that shows nothing but says it has something to show. This is the
   * guard that catches a tool added without a builder.
   */
  it('produces a preview for every write tool', async () => {
    const args: Record<string, unknown> = {
      id: 'note-1',
      task_id: 'task-1',
      canvas_id: 'canvas-1',
      date: '2026-09-18',
      path: 'Work',
      old_path: 'Work',
      new_path: 'Archive',
      folder_path: 'Archive',
      title: 'Title',
      name: 'Name',
      tag: 'work',
      kind: 'note',
      content: 'body',
      content_markdown: 'body',
      mode: 'replace',
      source: 'api',
      snooze_until: '2026-10-01',
      operation: 'calendar.create',
      args: [],
      items: [],
      elements: [],
      edits: [],
      task_ids: ['task-1'],
      project_ids: ['project-1'],
      status_ids: ['todo'],
      entity_id: 'note-1',
      entity_type: 'note',
      position: 1
    }

    for (const toolName of WRITE_TOOL_NAMES) {
      const preview = await buildChangePreview(toolName, args, handles())
      expect(preview.kind, toolName).not.toBe('none')
      expect(preview.item.title, toolName).not.toBe('')
    }
  })

  it('diffs a note body against what is stored, not against the agent text alone', async () => {
    const preview = await buildChangePreview(
      'vault_update_note',
      { id: 'note-1', mode: 'append', content_markdown: 'Owner: Kaan.' },
      handles()
    )

    expect(preview.kind).toBe('body')
    expect(preview.body?.current).toBe('Hiring stays paused until the next board review.')
    expect(preview.body?.candidate).toBe(
      'Hiring stays paused until the next board review.\n\nOwner: Kaan.'
    )
    expect(preview.item.context).toBe('Work/Planning')
  })

  /**
   * An agent patch usually carries columns it merely read. Listing the ones that
   * do not move is how a preview stops being read at all.
   */
  it('lists only the task columns that actually move', async () => {
    const preview = await buildChangePreview(
      'vault_update_task',
      {
        id: 'task-1',
        title: 'Ship the preview API',
        due_date: '2026-10-15',
        status_id: 'doing'
      },
      handles()
    )

    expect(preview.kind).toBe('fields')
    expect(preview.fields).toEqual([
      { key: 'status', before: 'todo', after: 'doing' },
      { key: 'due_date', before: '2026-10-12', after: '2026-10-15' }
    ])
  })

  it('treats an absent key as leave alone rather than as a clear', async () => {
    const preview = await buildChangePreview(
      'vault_update_task',
      { id: 'task-1', title: 'Renamed' },
      handles()
    )

    expect(preview.fields).toEqual([
      { key: 'title', before: 'Ship the preview API', after: 'Renamed' }
    ])
  })

  it('distinguishes an unset field from an empty one', async () => {
    const preview = await buildChangePreview(
      'vault_update_task',
      { id: 'task-1', priority: 2 },
      handles()
    )

    expect(preview.fields).toEqual([{ key: 'priority', before: '0', after: '2' }])
  })

  it('reports what a note delete takes with it, and flags it destructive', async () => {
    const preview = await buildChangePreview('vault_delete_note', { id: 'note-1' }, handles())

    expect(preview.kind).toBe('loss')
    expect(preview.destructive).toBe(true)
    expect(preview.loss).toContain('words:8')
    expect(preview.loss).toContain('tags:2')
    expect(preview.loss.some((entry) => entry.startsWith('excerpt:'))).toBe(true)
  })

  it('counts what a folder delete would take', async () => {
    const preview = await buildChangePreview('vault_delete_folder', { path: 'Work' }, handles())

    expect(preview.loss).toEqual(['notes:2', 'folders:1'])
    expect(preview.destructive).toBe(true)
  })

  it('reports project links, not just the task count, for a project delete', async () => {
    const preview = await buildChangePreview('vault_delete_project', { id: 'project-1' }, handles())

    expect(preview.loss).toEqual(['tasks:4', 'notes:2', 'files:3', 'events:1'])
  })

  /**
   * The tool can move either the title or the body, so the shape follows the
   * arguments rather than the tool name. A rename does not deserve a text pane.
   */
  it('shows an inbox title change as a field and a content change as a body', async () => {
    const titleOnly = await buildChangePreview(
      'vault_update_inbox_item',
      { id: 'inbox-1', title: 'Renamed' },
      handles()
    )
    expect(titleOnly.kind).toBe('fields')
    expect(titleOnly.body).toBeNull()

    const contentChange = await buildChangePreview(
      'vault_update_inbox_item',
      { id: 'inbox-1', content: 'Rewritten body.' },
      handles()
    )
    expect(contentChange.kind).toBe('body')
    expect(contentChange.body).toEqual({
      current: 'Long capture body.',
      candidate: 'Rewritten body.'
    })
  })

  it('projects the tag list a tag write would produce', async () => {
    const added = await buildChangePreview(
      'vault_add_tag',
      { id: 'note-1', kind: 'note', tag: 'q4' },
      handles()
    )
    expect(added.fields).toEqual([
      { key: 'tags', before: 'work, planning', after: 'work, planning, q4' }
    ])

    const removed = await buildChangePreview(
      'vault_remove_tag',
      { id: 'note-1', kind: 'note', tag: 'work' },
      handles()
    )
    expect(removed.fields).toEqual([{ key: 'tags', before: 'work, planning', after: 'planning' }])
  })

  it('reads a task, not a note, when a tag write names a task', async () => {
    const vault = handles()
    const preview = await buildChangePreview(
      'vault_add_tag',
      { id: 'task-1', kind: 'task', tag: 'urgent' },
      vault
    )

    expect(preview.item.type).toBe('task')
    expect(preview.item.title).toBe('Ship the preview API')
    expect(vault.notes.read).not.toHaveBeenCalled()
  })

  /**
   * A tool with no builder still has to draw something. A card with no content
   * is worse than a coarse one: the user cannot tell whether the write is small
   * or the preview is broken.
   */
  it('names the operation and its arguments for a tool it does not know', async () => {
    const preview = await buildChangePreview(
      'vault_invent_something',
      { id: 'thing-1', count: 3, untouched: null },
      handles()
    )

    expect(preview.kind).toBe('fields')
    expect(preview.item.title).toBe('vault_invent_something')
    expect(preview.fields).toEqual([
      { key: 'id', before: null, after: 'thing-1' },
      { key: 'count', before: null, after: '3' }
    ])
  })

  it('reads arguments that are not an object as no arguments at all', async () => {
    const preview = await buildChangePreview('vault_invent_something', 'nonsense', handles())

    expect(preview.fields).toEqual([])
    expect(preview.item.title).toBe('vault_invent_something')
  })

  it('says nothing is lost when a project has no tasks or links', async () => {
    const vault = handles({
      projects: {
        get: vi.fn(async () => null),
        list: vi.fn(async () => [
          {
            id: 'project-1',
            name: 'Empty',
            status: null,
            task_count: 0,
            icon: null,
            home_note_id: null,
            linked_counts: { notes: 0, files: 0, events: 0 }
          }
        ])
      }
    })

    const preview = await buildChangePreview('vault_delete_project', { id: 'project-1' }, vault)

    expect(preview.loss).toEqual([])
    expect(preview.destructive).toBe(true)
    expect(preview.item.title).toBe('Empty')
  })

  it('throws rather than inventing a before when the note is gone', async () => {
    const vault = handles({ notes: { read: vi.fn(async () => null) } })

    await expect(
      buildChangePreview('vault_update_note', { id: 'ghost', mode: 'replace' }, vault)
    ).rejects.toThrow('Note not found: ghost')
  })
})

describe('buildPreviewDiffResponse', () => {
  /**
   * The legacy triple stays populated so a window running an older renderer
   * bundle draws the old two-column view instead of nothing.
   */
  it('fills the legacy note-body triple from the typed preview', async () => {
    const response = await buildPreviewDiffResponse(
      {
        toolName: 'vault_update_note',
        args: { id: 'note-1', mode: 'replace', content_markdown: 'New.' }
      },
      handles()
    )

    expect(response.title).toBe('Q4 planning')
    expect(response.current).toBe('Hiring stays paused until the next board review.')
    expect(response.candidate).toBe('New.')
    expect(response.preview.kind).toBe('body')
  })

  it('leaves the legacy body strings empty for a change that has no body', async () => {
    const response = await buildPreviewDiffResponse(
      { toolName: 'vault_complete_task', args: { id: 'task-1' } },
      handles()
    )

    expect(response.current).toBe('')
    expect(response.candidate).toBe('')
    expect(response.preview.kind).toBe('fields')
  })
})
