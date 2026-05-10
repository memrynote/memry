import { describe, it, expect } from 'vitest'
import { buildClaudeAllowedToolsList, MCP_NAMESPACE } from '../registry'
import { ALL_TOOL_NAMES } from '../tools/schemas'

describe('Tool registry', () => {
  it('emits the namespace prefix expected by Claude --allowed-tools', () => {
    expect(MCP_NAMESPACE).toBe('memry')
  })

  it('builds a comma-separated list of mcp__memry__* names matching ALL_TOOL_NAMES', () => {
    const list = buildClaudeAllowedToolsList()
    const names = list.split(',')
    expect(names).toHaveLength(ALL_TOOL_NAMES.length)
    expect(names[0]).toBe('mcp__memry__vault_search_notes')
    for (const tool of ALL_TOOL_NAMES) {
      expect(names).toContain(`mcp__memry__${tool}`)
    }
  })
})
