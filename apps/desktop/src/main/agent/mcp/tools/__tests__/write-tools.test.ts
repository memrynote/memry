import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildWriteTools, type WriteToolGate } from '../write-tools'
import { WRITE_TOOL_NAMES } from '../schemas'
import type { VaultServiceHandles } from '../handles'

const handles: VaultServiceHandles = {
  notes: {
    search: async () => [],
    read: async () => null,
    create: async () => ({ id: 'created-note' }),
    update: async () => {},
    addTag: async () => {},
    removeTag: async () => {},
    moveToFolder: async () => {}
  },
  folders: { list: async () => [] },
  tasks: {
    list: async () => [],
    create: async () => ({ id: 'created-task' }),
    update: async () => {},
    addTag: async () => {},
    removeTag: async () => {}
  },
  projects: { list: async () => [] },
  journal: {
    getByDate: async () => null,
    listInRange: async () => [],
    createIfMissing: async () => ({ id: 'jrnl', created: true })
  },
  inbox: { list: async () => [], add: async () => ({ id: 'inbox' }) },
  tags: { listAll: async () => [] },
  windows: { snapshotCurrentNote: async () => null }
}

describe('Write tools — P1 deny-by-default', () => {
  let tools: ReturnType<typeof buildWriteTools>

  beforeEach(() => {
    tools = buildWriteTools(handles, null)
  })

  it('registers all 9 write tools', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...WRITE_TOOL_NAMES].sort())
  })

  it('returns PERMISSION_DENIED for vault_create_note when no gate is wired', async () => {
    const t = tools.find((x) => x.name === 'vault_create_note')!
    await expect(
      t.handler({ title: 't', content_markdown: 'body' }, { conversationId: null, windowId: null })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('returns PERMISSION_DENIED for every write tool with valid args and no gate', async () => {
    const valid: Record<string, unknown> = {
      vault_create_note: { title: 't', content_markdown: 'b' },
      vault_create_task: { title: 't' },
      vault_create_journal_entry: { date: '2026-05-10', content_markdown: 'b' },
      vault_add_to_inbox: { source: 'cli', title: 't', content: 'b' },
      vault_update_note: { id: 'x', mode: 'append', content_markdown: 'b' },
      vault_update_task: { id: 'x', title: 'new' },
      vault_add_tag: { id: 'x', kind: 'note', tag: 'a' },
      vault_remove_tag: { id: 'x', kind: 'note', tag: 'a' },
      vault_move_to_folder: { id: 'x', folder_path: '/Inbox' }
    }
    for (const t of tools) {
      await expect(
        t.handler(valid[t.name], { conversationId: null, windowId: null })
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    }
  })

  it('still rejects malformed args with VALIDATION before gating', async () => {
    const t = tools.find((x) => x.name === 'vault_create_note')!
    await expect(
      t.handler({ title: '' }, { conversationId: null, windowId: null })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('forwards to handles when a gate approves', async () => {
    const gate: WriteToolGate = async () => ({ approved: true, args: undefined })
    const withGate = buildWriteTools(handles, gate)
    const t = withGate.find((x) => x.name === 'vault_create_note')!
    const out = await t.handler(
      { title: 'x', content_markdown: 'y' },
      { conversationId: 'c1', windowId: 'w1' }
    )
    expect(out).toEqual({ id: 'created-note' })
  })

  it('lets the gate edit args before forwarding', async () => {
    let received: { title: string; content_markdown: string } | null = null
    const localHandles: VaultServiceHandles = {
      ...handles,
      notes: {
        ...handles.notes,
        create: async (input) => {
          received = input
          return { id: 'note-edited' }
        }
      }
    }
    const gate: WriteToolGate = async () => ({
      approved: true,
      args: { title: 'EDITED', content_markdown: 'EDITED-BODY' }
    })
    const withGate = buildWriteTools(localHandles, gate)
    const t = withGate.find((x) => x.name === 'vault_create_note')!
    await t.handler(
      { title: 'orig', content_markdown: 'orig' },
      { conversationId: 'c1', windowId: 'w1' }
    )
    expect(received).toEqual({ title: 'EDITED', content_markdown: 'EDITED-BODY' })
  })

  it('forwards approved write tools to the matching vault handles', async () => {
    const localHandles: VaultServiceHandles = {
      ...handles,
      notes: {
        ...handles.notes,
        update: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}),
        removeTag: vi.fn(async () => {}),
        moveToFolder: vi.fn(async () => {})
      },
      tasks: {
        ...handles.tasks,
        create: vi.fn(async () => ({ id: 'task-created' })),
        update: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}),
        removeTag: vi.fn(async () => {})
      },
      journal: {
        ...handles.journal,
        createIfMissing: vi.fn(async () => ({ id: 'jrnl', created: true }))
      },
      inbox: {
        ...handles.inbox,
        add: vi.fn(async () => ({ id: 'inbox-created' }))
      }
    }
    const withGate = buildWriteTools(localHandles, async () => ({ approved: true }))
    const run = async (name: string, input: unknown) => {
      const tool = withGate.find((x) => x.name === name)!
      return tool.handler(input, { conversationId: 'c1', windowId: 'w1' })
    }

    await expect(run('vault_create_task', { title: 'Task' })).resolves.toEqual({
      id: 'task-created'
    })
    await expect(
      run('vault_create_journal_entry', { date: '2026-05-10', content_markdown: 'Entry' })
    ).resolves.toEqual({ id: 'jrnl', created: true })
    await expect(
      run('vault_add_to_inbox', { source: 'agent', title: 'Inbox', content: 'Body' })
    ).resolves.toEqual({ id: 'inbox-created' })
    await expect(
      run('vault_update_note', { id: 'note-1', mode: 'append', content_markdown: 'More' })
    ).resolves.toEqual({ id: 'note-1' })
    await expect(run('vault_update_task', { id: 'task-1', title: 'Updated' })).resolves.toEqual({
      id: 'task-1'
    })
    await expect(
      run('vault_add_tag', { id: 'task-1', kind: 'task', tag: 'work' })
    ).resolves.toEqual({ id: 'task-1' })
    await expect(
      run('vault_remove_tag', { id: 'task-1', kind: 'task', tag: 'work' })
    ).resolves.toEqual({ id: 'task-1' })
    await expect(
      run('vault_move_to_folder', { id: 'note-1', folder_path: '/Projects' })
    ).resolves.toEqual({ id: 'note-1' })

    expect(localHandles.notes.update).toHaveBeenCalledWith({
      id: 'note-1',
      mode: 'append',
      content_markdown: 'More'
    })
    expect(localHandles.tasks.update).toHaveBeenCalledWith('task-1', { title: 'Updated' })
    expect(localHandles.tasks.addTag).toHaveBeenCalledWith({
      id: 'task-1',
      tag: 'work'
    })
    expect(localHandles.tasks.removeTag).toHaveBeenCalledWith({
      id: 'task-1',
      tag: 'work'
    })
    expect(localHandles.notes.moveToFolder).toHaveBeenCalledWith({
      id: 'note-1',
      folder_path: '/Projects'
    })
  })

  it('returns PERMISSION_DENIED when the gate denies', async () => {
    const gate: WriteToolGate = async () => ({ approved: false, reason: 'user denied' })
    const withGate = buildWriteTools(handles, gate)
    const t = withGate.find((x) => x.name === 'vault_create_note')!
    await expect(
      t.handler({ title: 't', content_markdown: 'b' }, { conversationId: 'c1', windowId: 'w1' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
})
