import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildWriteTools, type WriteToolGate } from '../write-tools'
import { WRITE_TOOL_NAMES } from '../schemas'
import type { VaultServiceHandles } from '../handles'

const handles: VaultServiceHandles = {
  notes: {
    search: async () => [],
    read: async () => null,
    create: async () => ({ id: 'created-note' }),
    rename: async ({ id }) => ({ id }),
    delete: async (id) => ({ id }),
    update: async () => {},
    addTag: async () => {},
    removeTag: async () => {},
    moveToFolder: async () => {}
  },
  folders: {
    list: async () => [],
    create: async (path) => ({ path }),
    rename: async ({ new_path }) => ({ path: new_path }),
    delete: async (path) => ({ path })
  },
  tasks: {
    list: async () => [],
    get: async () => null,
    create: async () => ({ id: 'created-task' }),
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
    list: async () => [],
    get: async () => null,
    create: async () => ({ id: 'created-project' }),
    update: async ({ id }) => ({ id }),
    delete: async (id) => ({ id }),
    archive: async (id) => ({ id }),
    reorder: async ({ project_ids }) => ({ ids: project_ids })
  },
  statuses: {
    list: async () => [],
    create: async () => ({ id: 'created-status' }),
    update: async ({ id }) => ({ id }),
    delete: async (id) => ({ id }),
    reorder: async ({ status_ids }) => ({ ids: status_ids })
  },
  journal: {
    getByDate: async () => null,
    listInRange: async () => [],
    createIfMissing: async () => ({ id: 'jrnl', created: true }),
    update: async () => ({ id: 'jrnl' }),
    delete: async (date) => ({ date, deleted: true })
  },
  inbox: {
    list: async () => [],
    get: async () => null,
    add: async () => ({ id: 'inbox' }),
    update: async ({ id }) => ({ id }),
    snooze: async ({ id }) => ({ id }),
    archive: async (id) => ({ id }),
    unarchive: async (id) => ({ id }),
    delete: async (id) => ({ id }),
    addTag: async ({ id }) => ({ id }),
    removeTag: async ({ id }) => ({ id })
  },
  tags: { listAll: async () => [] },
  canvas: {
    list: async () => [],
    read: async () => null,
    addItems: vi.fn(async ({ canvasId }) => ({
      canvas_id: canvasId,
      applied: [],
      skipped: [],
      updated_at: 0,
      too_large: false
    })),
    removeItem: vi.fn(async ({ canvasId }) => ({
      canvas_id: canvasId,
      applied: [],
      skipped: [],
      updated_at: 0,
      too_large: false
    }))
  },
  desktop: {
    read: async () => ({ ok: true }),
    write: async ({ operation, args }, windowId) => ({ operation, args, windowId })
  },
  windows: { snapshotCurrentNote: async () => null }
}

describe('Write tools — P1 deny-by-default', () => {
  let tools: ReturnType<typeof buildWriteTools>

  beforeEach(() => {
    tools = buildWriteTools(handles, null)
  })

  it('registers all write tools', () => {
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
      vault_rename_note: { id: 'x', title: 'renamed' },
      vault_delete_note: { id: 'x' },
      vault_create_folder: { path: '/Projects' },
      vault_rename_folder: { old_path: '/Projects', new_path: '/Archive' },
      vault_delete_folder: { path: '/Archive' },
      vault_create_task: { title: 't' },
      vault_delete_task: { id: 'x' },
      vault_complete_task: { id: 'x' },
      vault_uncomplete_task: { id: 'x' },
      vault_archive_task: { id: 'x' },
      vault_unarchive_task: { id: 'x' },
      vault_move_task: { task_id: 'x', target_project_id: 'p1', position: 1 },
      vault_reorder_tasks: { task_ids: ['x'], positions: [0] },
      vault_duplicate_task: { id: 'x' },
      vault_convert_task_to_subtask: { task_id: 'x', parent_id: 'parent' },
      vault_convert_subtask_to_task: { id: 'x' },
      vault_create_project: { name: 'Project' },
      vault_update_project: { id: 'p1', name: 'Renamed' },
      vault_delete_project: { id: 'p1' },
      vault_archive_project: { id: 'p1' },
      vault_reorder_projects: { project_ids: ['p1'], positions: [0] },
      vault_create_status: { project_id: 'p1', name: 'Blocked' },
      vault_update_status: { id: 's1', name: 'Doing' },
      vault_delete_status: { id: 's1' },
      vault_reorder_statuses: { status_ids: ['s1'], positions: [0] },
      vault_create_journal_entry: { date: '2026-05-10', content_markdown: 'b' },
      vault_update_journal_entry: { date: '2026-05-10', content_markdown: 'b' },
      vault_delete_journal_entry: { date: '2026-05-10' },
      vault_add_to_inbox: { source: 'cli', title: 't', content: 'b' },
      vault_update_inbox_item: { id: 'i1', title: 'Updated' },
      vault_snooze_inbox_item: {
        id: 'i1',
        snooze_until: '2026-05-15T09:00:00.000Z',
        reason: 'Review later'
      },
      vault_archive_inbox_item: { id: 'i1' },
      vault_unarchive_inbox_item: { id: 'i1' },
      vault_delete_inbox_item: { id: 'i1' },
      vault_add_inbox_tag: { id: 'i1', tag: 'work' },
      vault_remove_inbox_tag: { id: 'i1', tag: 'work' },
      vault_update_note: { id: 'x', mode: 'append', content_markdown: 'b' },
      vault_update_task: { id: 'x', title: 'new' },
      vault_add_tag: { id: 'x', kind: 'note', tag: 'a' },
      vault_remove_tag: { id: 'x', kind: 'note', tag: 'a' },
      vault_move_to_folder: { id: 'x', folder_path: '/Inbox' },
      vault_add_canvas_item: {
        canvas_id: 'c1',
        items: [{ entity_type: 'note', entity_id: 'n1' }]
      },
      vault_remove_canvas_item: { canvas_id: 'c1', entity_type: 'note', entity_id: 'n1' },
      vault_desktop_write: { operation: 'templates.create', args: [{ name: 'Template' }] }
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
        rename: vi.fn(async ({ id }) => ({ id })),
        delete: vi.fn(async (id) => ({ id })),
        update: vi.fn(async () => {}),
        addTag: vi.fn(async () => {}),
        removeTag: vi.fn(async () => {}),
        moveToFolder: vi.fn(async () => {})
      },
      folders: {
        ...handles.folders,
        create: vi.fn(async (path) => ({ path })),
        rename: vi.fn(async ({ new_path }) => ({ path: new_path })),
        delete: vi.fn(async (path) => ({ path }))
      },
      tasks: {
        ...handles.tasks,
        create: vi.fn(async () => ({ id: 'task-created' })),
        update: vi.fn(async () => {}),
        delete: vi.fn(async (id) => ({ id })),
        archive: vi.fn(async (id) => ({ id })),
        move: vi.fn(async ({ task_id }) => ({ id: task_id })),
        addTag: vi.fn(async () => {}),
        removeTag: vi.fn(async () => {})
      },
      projects: {
        ...handles.projects,
        create: vi.fn(async () => ({ id: 'project-created' })),
        update: vi.fn(async ({ id }) => ({ id })),
        delete: vi.fn(async (id) => ({ id }))
      },
      statuses: {
        ...handles.statuses,
        create: vi.fn(async () => ({ id: 'status-created' })),
        update: vi.fn(async ({ id }) => ({ id })),
        delete: vi.fn(async (id) => ({ id }))
      },
      journal: {
        ...handles.journal,
        createIfMissing: vi.fn(async () => ({ id: 'jrnl', created: true })),
        update: vi.fn(async () => ({ id: 'jrnl' })),
        delete: vi.fn(async (date) => ({ date, deleted: true }))
      },
      inbox: {
        ...handles.inbox,
        add: vi.fn(async () => ({ id: 'inbox-created' })),
        update: vi.fn(async ({ id }) => ({ id })),
        snooze: vi.fn(async ({ id }) => ({ id })),
        archive: vi.fn(async (id) => ({ id })),
        unarchive: vi.fn(async (id) => ({ id })),
        delete: vi.fn(async (id) => ({ id })),
        addTag: vi.fn(async ({ id }) => ({ id })),
        removeTag: vi.fn(async ({ id }) => ({ id }))
      },
      desktop: {
        ...handles.desktop,
        write: vi.fn(async ({ operation, args }, windowId) => ({ operation, args, windowId }))
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
    await expect(run('vault_rename_note', { id: 'note-1', title: 'Renamed' })).resolves.toEqual({
      id: 'note-1'
    })
    await expect(run('vault_delete_note', { id: 'note-1' })).resolves.toEqual({ id: 'note-1' })
    await expect(run('vault_create_folder', { path: '/Projects' })).resolves.toEqual({
      path: '/Projects'
    })
    await expect(
      run('vault_rename_folder', { old_path: '/Projects', new_path: '/Archive' })
    ).resolves.toEqual({
      path: '/Archive'
    })
    await expect(run('vault_delete_folder', { path: '/Archive' })).resolves.toEqual({
      path: '/Archive'
    })
    await expect(run('vault_complete_task', { id: 'task-1' })).resolves.toEqual({
      id: 'task-1'
    })
    await expect(run('vault_uncomplete_task', { id: 'task-1' })).resolves.toEqual({
      id: 'task-1'
    })
    await expect(run('vault_archive_task', { id: 'task-1' })).resolves.toEqual({
      id: 'task-1'
    })
    await expect(run('vault_unarchive_task', { id: 'task-1' })).resolves.toEqual({
      id: 'task-1'
    })
    await expect(
      run('vault_move_task', { task_id: 'task-1', target_project_id: 'project-1', position: 2 })
    ).resolves.toEqual({
      id: 'task-1'
    })
    await expect(
      run('vault_reorder_tasks', { task_ids: ['task-1'], positions: [0] })
    ).resolves.toEqual({
      ids: ['task-1']
    })
    await expect(run('vault_duplicate_task', { id: 'task-1' })).resolves.toEqual({
      id: 'duplicated-task'
    })
    await expect(
      run('vault_convert_task_to_subtask', { task_id: 'task-1', parent_id: 'task-parent' })
    ).resolves.toEqual({
      id: 'task-1'
    })
    await expect(run('vault_convert_subtask_to_task', { id: 'task-1' })).resolves.toEqual({
      id: 'task-1'
    })
    await expect(
      run('vault_create_project', { name: 'Project', color: '#6366f1' })
    ).resolves.toEqual({ id: 'project-created' })
    await expect(run('vault_update_project', { id: 'project-1', name: 'Next' })).resolves.toEqual({
      id: 'project-1'
    })
    await expect(run('vault_delete_project', { id: 'project-1' })).resolves.toEqual({
      id: 'project-1'
    })
    await expect(run('vault_archive_project', { id: 'project-1' })).resolves.toEqual({
      id: 'project-1'
    })
    await expect(
      run('vault_reorder_projects', { project_ids: ['project-1'], positions: [0] })
    ).resolves.toEqual({
      ids: ['project-1']
    })
    await expect(
      run('vault_create_status', { project_id: 'project-1', name: 'Doing' })
    ).resolves.toEqual({
      id: 'status-created'
    })
    await expect(run('vault_update_status', { id: 'status-1', name: 'Review' })).resolves.toEqual({
      id: 'status-1'
    })
    await expect(run('vault_delete_status', { id: 'status-1' })).resolves.toEqual({
      id: 'status-1'
    })
    await expect(
      run('vault_reorder_statuses', { status_ids: ['status-1'], positions: [0] })
    ).resolves.toEqual({
      ids: ['status-1']
    })
    await expect(
      run('vault_update_journal_entry', { date: '2026-05-10', content_markdown: 'Updated' })
    ).resolves.toEqual({ id: 'jrnl' })
    await expect(run('vault_delete_journal_entry', { date: '2026-05-10' })).resolves.toEqual({
      date: '2026-05-10',
      deleted: true
    })
    await expect(
      run('vault_update_inbox_item', { id: 'inbox-1', title: 'Updated' })
    ).resolves.toEqual({
      id: 'inbox-1'
    })
    await expect(
      run('vault_snooze_inbox_item', {
        id: 'inbox-1',
        snooze_until: '2026-05-15T09:00:00.000Z',
        reason: 'Review tomorrow'
      })
    ).resolves.toEqual({
      id: 'inbox-1'
    })
    await expect(run('vault_archive_inbox_item', { id: 'inbox-1' })).resolves.toEqual({
      id: 'inbox-1'
    })
    await expect(run('vault_unarchive_inbox_item', { id: 'inbox-1' })).resolves.toEqual({
      id: 'inbox-1'
    })
    await expect(run('vault_delete_inbox_item', { id: 'inbox-1' })).resolves.toEqual({
      id: 'inbox-1'
    })
    await expect(run('vault_add_inbox_tag', { id: 'inbox-1', tag: 'work' })).resolves.toEqual({
      id: 'inbox-1'
    })
    await expect(run('vault_remove_inbox_tag', { id: 'inbox-1', tag: 'work' })).resolves.toEqual({
      id: 'inbox-1'
    })
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
      run('vault_add_tag', { id: 'note-1', kind: 'note', tag: 'work' })
    ).resolves.toEqual({ id: 'note-1' })
    await expect(
      run('vault_remove_tag', { id: 'task-1', kind: 'task', tag: 'work' })
    ).resolves.toEqual({ id: 'task-1' })
    await expect(
      run('vault_remove_tag', { id: 'note-1', kind: 'note', tag: 'work' })
    ).resolves.toEqual({ id: 'note-1' })
    await expect(
      run('vault_move_to_folder', { id: 'note-1', folder_path: '/Projects' })
    ).resolves.toEqual({ id: 'note-1' })
    await expect(
      run('vault_add_canvas_item', {
        canvas_id: 'canvas-1',
        items: [{ entity_type: 'note', entity_id: 'note-1' }]
      })
    ).resolves.toMatchObject({ canvas_id: 'canvas-1' })
    await expect(
      run('vault_remove_canvas_item', {
        canvas_id: 'canvas-1',
        entity_type: 'note',
        entity_id: 'note-1'
      })
    ).resolves.toMatchObject({ canvas_id: 'canvas-1' })
    await expect(
      run('vault_desktop_write', { operation: 'templates.create', args: [{ name: 'Template' }] })
    ).resolves.toEqual({
      operation: 'templates.create',
      args: [{ name: 'Template' }],
      windowId: 'w1'
    })

    expect(localHandles.notes.update).toHaveBeenCalledWith({
      id: 'note-1',
      mode: 'append',
      content_markdown: 'More'
    })
    expect(localHandles.notes.rename).toHaveBeenCalledWith({ id: 'note-1', title: 'Renamed' })
    expect(localHandles.notes.delete).toHaveBeenCalledWith('note-1')
    expect(localHandles.notes.addTag).toHaveBeenCalledWith({
      id: 'note-1',
      tag: 'work'
    })
    expect(localHandles.notes.removeTag).toHaveBeenCalledWith({
      id: 'note-1',
      tag: 'work'
    })
    expect(localHandles.folders.create).toHaveBeenCalledWith('/Projects')
    expect(localHandles.folders.rename).toHaveBeenCalledWith({
      old_path: '/Projects',
      new_path: '/Archive'
    })
    expect(localHandles.folders.delete).toHaveBeenCalledWith('/Archive')
    expect(localHandles.projects.create).toHaveBeenCalledWith({ name: 'Project', color: '#6366f1' })
    expect(localHandles.projects.update).toHaveBeenCalledWith({ id: 'project-1', name: 'Next' })
    expect(localHandles.projects.delete).toHaveBeenCalledWith('project-1')
    expect(localHandles.statuses.create).toHaveBeenCalledWith({
      project_id: 'project-1',
      name: 'Doing',
      color: '#6b7280',
      is_done: false
    })
    expect(localHandles.statuses.update).toHaveBeenCalledWith({ id: 'status-1', name: 'Review' })
    expect(localHandles.statuses.delete).toHaveBeenCalledWith('status-1')
    expect(localHandles.journal.update).toHaveBeenCalledWith({
      date: '2026-05-10',
      content_markdown: 'Updated'
    })
    expect(localHandles.journal.delete).toHaveBeenCalledWith('2026-05-10')
    expect(localHandles.inbox.update).toHaveBeenCalledWith({ id: 'inbox-1', title: 'Updated' })
    expect(localHandles.inbox.snooze).toHaveBeenCalledWith({
      id: 'inbox-1',
      snooze_until: '2026-05-15T09:00:00.000Z',
      reason: 'Review tomorrow'
    })
    expect(localHandles.inbox.archive).toHaveBeenCalledWith('inbox-1')
    expect(localHandles.inbox.unarchive).toHaveBeenCalledWith('inbox-1')
    expect(localHandles.inbox.delete).toHaveBeenCalledWith('inbox-1')
    expect(localHandles.inbox.addTag).toHaveBeenCalledWith({ id: 'inbox-1', tag: 'work' })
    expect(localHandles.inbox.removeTag).toHaveBeenCalledWith({ id: 'inbox-1', tag: 'work' })
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
    expect(localHandles.desktop.write).toHaveBeenCalledWith(
      { operation: 'templates.create', args: [{ name: 'Template' }] },
      'w1'
    )
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
