import { describe, it, expect, beforeEach } from 'vitest'
import { buildReadTools } from '../read-tools'
import type { VaultServiceHandles } from '../handles'
import { AgentToolError } from '../../errors'

function fake(): VaultServiceHandles {
  return {
    notes: {
      search: async ({ query }) =>
        query === 'hit'
          ? [{ id: 'n1', title: 'Hit', snippet: 'hit me', folder_path: '/Inbox' }]
          : [],
      read: async (id) =>
        id === 'n1'
          ? {
              id: 'n1',
              title: 'Hit',
              content_markdown: '# Hit',
              tags: ['t'],
              folder_path: '/Inbox',
              frontmatter: { foo: 1 }
            }
          : null,
      create: async () => ({ id: 'unused' }),
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
          : []
    },
    tasks: {
      list: async () => [
        { id: 't1', title: 'Buy milk', status: 'todo', due: null, project: null, tags: [] }
      ],
      create: async () => ({ id: 'unused' }),
      update: async () => {},
      addTag: async () => {},
      removeTag: async () => {}
    },
    projects: {
      list: async () => [{ id: 'p1', name: 'Memry', status: 'active', task_count: 5 }]
    },
    journal: {
      getByDate: async (date) =>
        date === '2026-05-10' ? { id: 'j1', date, content_markdown: '# Today' } : null,
      listInRange: async () => [{ id: 'j1', date: '2026-05-10', title: 'Today' }],
      createIfMissing: async () => ({ id: 'unused', created: false })
    },
    inbox: {
      list: async () => [{ id: 'i1', source: 'web', title: 'Cool', snippet: '...', captured_at: 0 }],
      add: async () => ({ id: 'unused' })
    },
    tags: {
      listAll: async () => [{ name: 'todo', count: 3 }]
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
  })

  it('vault_search_notes returns hits', async () => {
    const out = await tools
      .find((t) => t.name === 'vault_search_notes')!
      .handler({ query: 'hit' }, { conversationId: null, windowId: null })
    expect(out).toEqual([{ id: 'n1', title: 'Hit', snippet: 'hit me', folder_path: '/Inbox' }])
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

  it('vault_list_projects returns rows', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_projects')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(1)
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
      .handler({ from: '2026-05-01', to: '2026-05-31' }, {
        conversationId: null,
        windowId: null
      })) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_list_inbox_items returns rows', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_list_inbox_items')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toHaveLength(1)
  })

  it('vault_get_tags returns tag counts', async () => {
    const out = (await tools
      .find((t) => t.name === 'vault_get_tags')!
      .handler({}, { conversationId: null, windowId: null })) as unknown[]
    expect(out).toEqual([{ name: 'todo', count: 3 }])
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
    await expect(t.handler({ query: '' }, { conversationId: null, windowId: null })).rejects.toBeInstanceOf(
      AgentToolError
    )
  })
})
