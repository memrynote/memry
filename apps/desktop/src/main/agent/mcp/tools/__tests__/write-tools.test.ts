import { describe, it, expect, beforeEach } from 'vitest'
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
    await expect(t.handler({ title: '' }, { conversationId: null, windowId: null })).rejects.toMatchObject(
      { code: 'VALIDATION' }
    )
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

  it('returns PERMISSION_DENIED when the gate denies', async () => {
    const gate: WriteToolGate = async () => ({ approved: false, reason: 'user denied' })
    const withGate = buildWriteTools(handles, gate)
    const t = withGate.find((x) => x.name === 'vault_create_note')!
    await expect(
      t.handler({ title: 't', content_markdown: 'b' }, { conversationId: 'c1', windowId: 'w1' })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })
})
