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
      'vault_list_projects',
      'vault_get_journal_entry',
      'vault_list_journal_entries',
      'vault_list_inbox_items',
      'vault_get_tags',
      'vault_create_note',
      'vault_create_task',
      'vault_create_journal_entry',
      'vault_add_to_inbox',
      'vault_update_note',
      'vault_update_task',
      'vault_add_tag',
      'vault_remove_tag',
      'vault_move_to_folder'
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

  it('rejects unknown update_note modes', () => {
    const r = TOOL_SCHEMAS.vault_update_note.input.safeParse({
      id: 'x',
      mode: 'invalid',
      content_markdown: '...'
    })
    expect(r.success).toBe(false)
  })
})
