import { ALL_TOOL_NAMES } from './tools/schemas'

export const MCP_NAMESPACE = 'memry'

export function buildClaudeAllowedToolsList(): string {
  return ALL_TOOL_NAMES.map((name) => `mcp__${MCP_NAMESPACE}__${name}`).join(',')
}
