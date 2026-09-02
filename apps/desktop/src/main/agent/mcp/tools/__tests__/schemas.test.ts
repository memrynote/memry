import { describe, it, expect } from 'vitest'
import { TOOL_SCHEMAS, ALL_TOOL_NAMES, READ_TOOL_NAMES, WRITE_TOOL_NAMES } from '../schemas'

describe('Vault MCP tool schemas', () => {
  it('declares every tool the spec requires', () => {
    expect(ALL_TOOL_NAMES).toEqual([
      'vault_search_notes',
      'vault_read_note',
      'vault_list_folder',
      'vault_get_current_note',
      'vault_list_tasks',
      'vault_get_task',
      'vault_list_projects',
      'vault_get_project',
      'vault_list_statuses',
      'vault_get_journal_entry',
      'vault_list_journal_entries',
      'vault_list_inbox_items',
      'vault_get_inbox_item',
      'vault_get_tags',
      'vault_list_canvases',
      'vault_read_canvas',
      'vault_read_canvas_elements',
      'vault_desktop_read',
      'vault_create_note',
      'vault_rename_note',
      'vault_delete_note',
      'vault_create_folder',
      'vault_rename_folder',
      'vault_delete_folder',
      'vault_create_task',
      'vault_delete_task',
      'vault_complete_task',
      'vault_uncomplete_task',
      'vault_archive_task',
      'vault_unarchive_task',
      'vault_move_task',
      'vault_reorder_tasks',
      'vault_duplicate_task',
      'vault_convert_task_to_subtask',
      'vault_convert_subtask_to_task',
      'vault_create_project',
      'vault_update_project',
      'vault_delete_project',
      'vault_archive_project',
      'vault_reorder_projects',
      'vault_create_status',
      'vault_update_status',
      'vault_delete_status',
      'vault_reorder_statuses',
      'vault_create_journal_entry',
      'vault_update_journal_entry',
      'vault_delete_journal_entry',
      'vault_add_to_inbox',
      'vault_update_inbox_item',
      'vault_snooze_inbox_item',
      'vault_archive_inbox_item',
      'vault_unarchive_inbox_item',
      'vault_delete_inbox_item',
      'vault_add_inbox_tag',
      'vault_remove_inbox_tag',
      'vault_update_note',
      'vault_update_task',
      'vault_add_tag',
      'vault_remove_tag',
      'vault_move_to_folder',
      'vault_add_canvas_item',
      'vault_remove_canvas_item',
      'vault_create_canvas',
      'vault_draw_on_canvas',
      'vault_edit_canvas_elements',
      'vault_desktop_write'
    ])
  })

  it('partitions tools by mutation semantics', () => {
    expect(READ_TOOL_NAMES).toContain('vault_search_notes')
    expect(READ_TOOL_NAMES).not.toContain('vault_create_note')
    expect(WRITE_TOOL_NAMES).toContain('vault_create_note')
    expect(WRITE_TOOL_NAMES).toContain('vault_update_note')
    expect(WRITE_TOOL_NAMES).not.toContain('vault_read_note')
  })

  it('round-trips a known-good search input', () => {
    const parsed = TOOL_SCHEMAS.vault_search_notes.input.parse({ query: 'hello', limit: 10 })
    expect(parsed).toEqual({ query: 'hello', limit: 10 })
  })

  it('rejects an empty query for search', () => {
    const r = TOOL_SCHEMAS.vault_search_notes.input.safeParse({ query: '' })
    expect(r.success).toBe(false)
  })

  it('accepts a file_types filter for search', () => {
    const parsed = TOOL_SCHEMAS.vault_search_notes.input.parse({
      query: 'invoice',
      file_types: ['markdown', 'pdf']
    })
    expect(parsed).toEqual({ query: 'invoice', file_types: ['markdown', 'pdf'] })
  })

  it('rejects an unknown file_type for search', () => {
    const r = TOOL_SCHEMAS.vault_search_notes.input.safeParse({
      query: 'invoice',
      file_types: ['spreadsheet']
    })
    expect(r.success).toBe(false)
  })

  it('rejects an empty file_types array for search', () => {
    const r = TOOL_SCHEMAS.vault_search_notes.input.safeParse({ query: 'invoice', file_types: [] })
    expect(r.success).toBe(false)
  })

  it('rejects unknown update_note modes', () => {
    const r = TOOL_SCHEMAS.vault_update_note.input.safeParse({
      id: 'x',
      mode: 'invalid',
      content_markdown: '...'
    })
    expect(r.success).toBe(false)
  })

  it('validates inbox snooze input as an ISO datetime', () => {
    expect(
      TOOL_SCHEMAS.vault_snooze_inbox_item.input.parse({
        id: 'inbox-1',
        snooze_until: '2026-05-15T09:00:00.000Z',
        reason: 'Review tomorrow'
      })
    ).toEqual({
      id: 'inbox-1',
      snooze_until: '2026-05-15T09:00:00.000Z',
      reason: 'Review tomorrow'
    })

    expect(
      TOOL_SCHEMAS.vault_snooze_inbox_item.input.safeParse({
        id: 'inbox-1',
        snooze_until: '2026-05-15'
      }).success
    ).toBe(false)
  })

  it('keeps the desktop bridge scoped to allowlisted CRUD operations', () => {
    expect(
      TOOL_SCHEMAS.vault_desktop_read.input.parse({
        operation: 'graph.getLocal',
        args: [{ noteId: 'note-1' }]
      })
    ).toEqual({
      operation: 'graph.getLocal',
      args: [{ noteId: 'note-1' }]
    })
    expect(
      TOOL_SCHEMAS.vault_desktop_write.input.parse({
        operation: 'templates.create',
        args: [{ name: 'Template' }]
      })
    ).toEqual({
      operation: 'templates.create',
      args: [{ name: 'Template' }]
    })
    expect(
      TOOL_SCHEMAS.vault_desktop_write.input.safeParse({
        operation: 'account.signOut',
        args: []
      }).success
    ).toBe(false)
  })
  // The agent's task writes reach the tasks domain through handles-adapter, not
  // through the IPC handler, so TaskCreateSchema never sees them and this schema
  // is the only place an impossible date can be stopped.
  it('refuses a task date the calendar does not have', () => {
    const create = (patch: Record<string, unknown>) =>
      TOOL_SCHEMAS.vault_create_task.input.safeParse({ title: 'Task', ...patch }).success

    for (const date of ['2026-02-30', '2025-02-29', '2026-13-01']) {
      expect(create({ due_date: date })).toBe(false)
      expect(create({ start_date: date })).toBe(false)
      expect(create({ due: date })).toBe(false)
      expect(
        TOOL_SCHEMAS.vault_update_task.input.safeParse({ id: 'task-1', due_date: date }).success
      ).toBe(false)
    }

    expect(create({ due_date: '2024-02-29', start_date: '2024-02-29', due: '2024-02-29' })).toBe(
      true
    )
    expect(
      TOOL_SCHEMAS.vault_update_task.input.safeParse({ id: 'task-1', due_date: '2024-02-29' })
        .success
    ).toBe(true)
  })
})
