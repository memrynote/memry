import { describe, it, expect, beforeEach } from 'vitest'
import { buildReadTools } from '../read-tools'
import type { VaultServiceHandles } from '../handles'
import { AgentToolError } from '../../errors'

let lastSearchInput: Parameters<VaultServiceHandles['notes']['search']>[0] | null = null

function fake(): VaultServiceHandles {
  return {
    notes: {
      search: async (input) => {
        lastSearchInput = input
        return input.query === 'hit'
          ? [
              {
                id: 'n1',
                title: 'Hit',
                snippet: 'hit me',
                folder_path: '/Inbox',
                file_type: 'markdown'
              },
              { id: 'f1', title: 'Scan', snippet: '', folder_path: '/Inbox', file_type: 'pdf' }
            ]
          : []
      },
      read: async (id) => {
        if (id === 'n1') {
          return {
            id: 'n1',
            title: 'Hit',
            content_markdown: '# Hit',
            tags: ['t'],
            folder_path: '/Inbox',
            frontmatter: { foo: 1 },
            file_type: 'markdown'
          }
        }
        if (id === 'f1') {
          return {
            id: 'f1',
            title: 'Scan',
            content_markdown: '',
            tags: [],
            folder_path: '/Inbox',
            frontmatter: {},
            file_type: 'pdf'
          }
        }
        return null
      },
      create: async () => ({ id: 'unused' }),
      rename: async ({ id }) => ({ id }),
      delete: async (id) => ({ id }),
      update: async () => {},
      addTag: async () => {},
      removeTag: async () => {},
      moveToFolder: async () => {}
    },
    folders: {
      list: async ({ path }) =>
        path === '/'
          ? [
              { kind: 'folder', id: 'f1', name: 'Inbox', path: '/Inbox' },
              { kind: 'note', id: 'n1', name: 'Hit', path: '/Inbox/Hit.md' }
            ]
          : [],
      create: async (path) => ({ path }),
      rename: async ({ new_path }) => ({ path: new_path }),
      delete: async (path) => ({ path })
    },
    tasks: {
      list: async () => [
        { id: 't1', title: 'Buy milk', status: 'todo', due: null, project: null, tags: [] }
      ],
      get: async (id) => (id === 't1' ? { id, title: 'Buy milk' } : null),
      create: async () => ({ id: 'unused' }),
      update: async () => {},
      delete: async (id) => ({ id }),
      complete: async ({ id }) => ({ id }),
      uncomplete: async (id) => ({ id }),
      archive: async (id) => ({ id }),
      unarchive: async (id) => ({ id }),
      move: async ({ task_id }) => ({ id: task_id }),
      reorder: async ({ task_ids }) => ({ ids: task_ids }),
      duplicate: async () => ({ id: 'duplicated-task' }),
      convertToSubtask: async ({ task_id }) => ({ id: task_id }),
      convertToTask: async (id) => ({ id }),
      addTag: async () => {},
      removeTag: async () => {}
    },
    projects: {
      list: async () => [
        {
          id: 'p1',
          name: 'memrynote',
          status: 'active',
          task_count: 5,
          icon: null,
          home_note_id: null,
          linked_counts: { notes: 0, files: 0, events: 0 }
        }
      ],
      get: async (id) => (id === 'p1' ? { id, name: 'memrynote' } : null),
      create: async () => ({ id: 'unused' }),
      update: async ({ id }) => ({ id }),
      delete: async (id) => ({ id }),
      archive: async (id) => ({ id }),
      reorder: async ({ project_ids }) => ({ ids: project_ids })
    },
    statuses: {
      list: async (projectId) => [{ id: 's1', projectId, name: 'Todo' }],
      create: async () => ({ id: 'unused' }),
      update: async ({ id }) => ({ id }),
      delete: async (id) => ({ id }),
      reorder: async ({ status_ids }) => ({ ids: status_ids })
    },
    journal: {
      getByDate: async (date) =>
        date === '2026-05-10' ? { id: 'j1', date, content_markdown: '# Today' } : null,
      listInRange: async () => [{ id: 'j1', date: '2026-05-10', title: 'Today' }],
      createIfMissing: async () => ({ id: 'unused', created: false }),
      update: async () => ({ id: 'unused' }),
      delete: async (date) => ({ date, deleted: true })
    },
    inbox: {
      list: async () => [
        { id: 'i1', source: 'web', title: 'Cool', snippet: '...', captured_at: 0 }
      ],
      get: async (id) => (id === 'i1' ? { id, title: 'Cool' } : null),
      add: async () => ({ id: 'unused' }),
      update: async ({ id }) => ({ id }),
      archive: async (id) => ({ id }),
      unarchive: async (id) => ({ id }),
      delete: async (id) => ({ id }),
      addTag: async ({ id }) => ({ id }),
      removeTag: async ({ id }) => ({ id })
    },
    tags: {
      listAll: async () => [{ name: 'todo', count: 3 }]
    },
    canvas: {
      list: async () => [{ id: 'c1', title: 'Roadmap', updated_at: 5, item_count: 2 }],
      read: async (id) =>
        id === 'c1'
          ? {
              id: 'c1',
              title: 'Roadmap',
              created_at: 1,
              updated_at: 5,
              items: [{ entity_type: 'note', entity_id: 'n1', title: 'Spec', missing: false }],
              texts: ['Q3'],
              element_count: 4,
              texts_truncated: false
            }
          : null,
      addItems: async ({ canvasId }) => ({
        canvas_id: canvasId,
        applied: [],
        skipped: [],
        updated_at: 0,
        too_large: false
      }),
      removeItem: async ({ canvasId }) => ({
        canvas_id: canvasId,
        applied: [],
        skipped: [],
        updated_at: 0,
        too_large: false
      })
    },
    desktop: {
      read: async ({ operation, args }, windowId) => ({ operation, args, windowId }),
      write: async () => ({ ok: true })
    },
    windows: {
      snapshotCurrentNote: async () => null
    }
  }
}

describe('Read tools', () => {
  let handles: VaultServiceHandles
  let tools: ReturnType<typeof buildReadTools>

  beforeEach(() => {
    handles = fake()
    tools = buildReadTools(handles)
    lastSearchInput = null
  })

  it('vault_search_notes returns hits tagged with their file type', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_search_notes')!
      .handler({ query: 'hit' }, { conversationId: null, windowId: null })
    expect(out).toEqual([
      { id: 'n1', title: 'Hit', snippet: 'hit me', folder_path: '/Inbox', file_type: 'markdown' },
      { id: 'f1', title: 'Scan', snippet: '', folder_path: '/Inbox', file_type: 'pdf' }
    ])
  })

  it('vault_search_notes forwards file_types to the search handle', async () => {
    await tools
      .find((t) => t.name === 'vault_search_notes')!
      .handler({ query: 'hit', file_types: ['markdown'] }, { conversationId: null, windowId: null })
    expect(lastSearchInput).toMatchObject({ query: 'hit', fileTypes: ['markdown'] })
  })

  it('vault_search_notes leaves fileTypes unset when no filter is given', async () => {
    await tools
      .find((t) => t.name === 'vault_search_notes')!
      .handler({ query: 'hit' }, { conversationId: null, windowId: null })
    expect(lastSearchInput?.fileTypes).toBeUndefined()
  })

  it('vault_read_note rejects a filed binary instead of returning it as markdown', async () => {
    await expect(
      tools
        .find((t) => t.name === 'vault_read_note')!
        .handler({ id: 'f1' }, { conversationId: null, windowId: null })
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { id: 'f1', file_type: 'pdf' } })
  })

  it('vault_read_note throws NOT_FOUND for missing note', async () => {
    await expect(
      tools
        .find((t) => t.name === 'vault_read_note')!
        .handler({ id: 'missing' }, { conversationId: null, windowId: null })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('vault_read_note returns full note', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_read_note')!
      .handler({ id: 'n1' }, { conversationId: null, windowId: null })
    expect(out).toMatchObject({ id: 'n1', title: 'Hit', content_markdown: '# Hit' })
  })

  it('vault_list_canvases returns canvases with item counts', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_list_canvases')!
      .handler({}, { conversationId: null, windowId: null })
    expect(out).toEqual([{ id: 'c1', title: 'Roadmap', updated_at: 5, item_count: 2 }])
  })

  it('vault_read_canvas returns entities and text but never the raw scene', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_read_canvas')!
      .handler({ id: 'c1' }, { conversationId: null, windowId: null })

    expect(out).toMatchObject({
      id: 'c1',
      items: [{ entity_type: 'note', entity_id: 'n1', title: 'Spec', missing: false }],
      texts: ['Q3']
    })
    expect(JSON.stringify(out)).not.toContain('"scene"')
  })

  it('vault_read_canvas throws NOT_FOUND for a missing canvas', async () => {
    await expect(
      tools
        .find((t) => t.name === 'vault_read_canvas')!
        .handler({ id: 'nope' }, { conversationId: null, windowId: null })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('vault_list_folder returns mixed entries', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_folder')!
      .handler({ path: '/' }, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(2)
  })

  it('vault_list_tasks returns rows', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_tasks')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_get_task returns a single task', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_task')!
      .handler({ id: 't1' }, { conversationId: null, windowId: null })
    expect(out).toMatchObject({ id: 't1', title: 'Buy milk' })
  })

  it('vault_list_projects returns rows', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_projects')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_get_project returns a single project', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_project')!
      .handler({ id: 'p1' }, { conversationId: null, windowId: null })
    expect(out).toMatchObject({ id: 'p1', name: 'memrynote' })
  })

  it('vault_list_statuses returns project statuses', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_statuses')!
      .handler({ project_id: 'p1' }, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toEqual([{ id: 's1', projectId: 'p1', name: 'Todo' }])
  })

  it('vault_get_journal_entry returns null for missing date', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_journal_entry')!
      .handler({ date: '2020-01-01' }, { conversationId: null, windowId: null })
    expect(out).toBeNull()
  })

  it('vault_get_journal_entry returns entry for known date', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_journal_entry')!
      .handler({ date: '2026-05-10' }, { conversationId: null, windowId: null })
    expect(out).toMatchObject({ id: 'j1', date: '2026-05-10' })
  })

  it('vault_list_journal_entries returns range', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_journal_entries')!
      .handler(
        { from: '2026-05-01', to: '2026-05-31' },
        {
          conversationId: null,
          windowId: null
        }
      )) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_list_inbox_items returns rows', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_inbox_items')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_get_inbox_item returns a single inbox item', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_inbox_item')!
      .handler({ id: 'i1' }, { conversationId: null, windowId: null })
    expect(out).toMatchObject({ id: 'i1', title: 'Cool' })
  })

  it('vault_get_tags returns tag counts', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_get_tags')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toEqual([{ name: 'todo', count: 3 }])
  })

  it('vault_desktop_read forwards allowlisted desktop read operations', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_desktop_read')!
      .handler(
        { operation: 'templates.list', args: [] },
        { conversationId: null, windowId: 'window-1' }
      )
    expect(out).toEqual({ operation: 'templates.list', args: [], windowId: 'window-1' })
  })

  it('vault_get_current_note returns null when window header missing', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_get_current_note')!
      .handler({}, { conversationId: null, windowId: null })
    expect(out).toBeNull()
  })

  it('vault_get_current_note delegates to windows.snapshotCurrentNote when window present', async () => {
    handles.windows.snapshotCurrentNote = async () => ({
      id: 'n1',
      title: 'Hit',
      content_markdown: '# Hit',
      tags: []
    })
    tools = buildReadTools(handles)
    const out = await tools
      .find((t) => t.name === 'vault_get_current_note')!
      .handler({}, { conversationId: null, windowId: 'win-1' })
    expect(out).toMatchObject({ id: 'n1', title: 'Hit' })
  })

  it('rejects an invalid input via Zod (bubbles VALIDATION error)', async () => {
    const t = tools.find((x) => x.name === 'vault_search_notes')!
    await expect(
      t.handler({ query: '' }, { conversationId: null, windowId: null })
    ).rejects.toBeInstanceOf(AgentToolError)
  })
})
