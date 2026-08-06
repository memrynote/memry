import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolSet } from 'ai'

import { createLogger } from '../../lib/logger'
import { trackMainError } from '../../telemetry/diagnostics'
import { ALL_TOOL_NAMES, TOOL_SCHEMAS, type ToolName } from '../mcp/tools/schemas'

const logger = createLogger('AgentToolBridge')

export interface AgentToolCallInput {
  conversationId: string
  windowId: string
  name: ToolName
  args: unknown
}

export type AgentToolCallResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } }

export type AgentMcpCallTool = (input: AgentToolCallInput) => Promise<AgentToolCallResult>

export class AgentToolBridge {
  constructor(private readonly deps: { callTool?: AgentMcpCallTool } = {}) {}

  async execute(input: AgentToolCallInput): Promise<AgentToolCallResult> {
    const callTool = this.deps.callTool ?? callVaultMcpTool
    return callTool(input)
  }
}

export function createAiSdkToolSet(
  bridge: AgentToolBridge,
  ctx: { conversationId: string; windowId: string }
): ToolSet {
  const tools: ToolSet = {}
  for (const name of ALL_TOOL_NAMES) {
    const schema = TOOL_SCHEMAS[name]
    tools[name] = {
      description: schema.description,
      inputSchema: schema.input,
      execute: async (args: unknown) =>
        bridge.execute({
          conversationId: ctx.conversationId,
          windowId: ctx.windowId,
          name,
          args
        })
    }
  }
  return tools
}

async function callVaultMcpTool(input: AgentToolCallInput): Promise<AgentToolCallResult> {
  const { getPublicStatus } = await import('../mcp/lifecycle')
  const status = getPublicStatus()
  if (!status.url || !status.token) {
    logger.warn('Vault MCP tool call skipped: agent MCP server is not running')
    return {
      ok: false,
      error: { code: 'MCP_UNAVAILABLE', message: 'Agent MCP server is not running.' }
    }
  }

  const transport = new StreamableHTTPClientTransport(new URL(`${status.url}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${status.token}`,
        'X-Memry-Conversation': input.conversationId,
        'X-Memry-Window': input.windowId
      }
    }
  })
  const client = new Client({ name: 'memry-agent-local', version: '1.0.0' })

  try {
    await client.connect(transport)
    const result = await client.callTool({
      name: input.name,
      arguments: toRecord(input.args)
    })
    if (result.isError) {
      return { ok: false, error: parseMcpError(result.content) }
    }
    return {
      ok: true,
      data: extractMcpResult(result as { structuredContent?: unknown; content?: unknown })
    }
  } catch (error) {
    // Transport-level failures (server down mid-call, connect/close errors,
    // malformed responses) never reach the MCP server's own logging.
    logger.warn(`Vault MCP tool transport failure for ${input.name}`, error)
    trackMainError('agent', 'mcp_tool_transport', error)
    return {
      ok: false,
      error: { code: 'MCP_TOOL_CALL_FAILED', message: errorMessage(error) }
    }
  } finally {
    await client.close()
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function extractMcpResult(result: { structuredContent?: unknown; content?: unknown }): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = firstTextContent(result.content)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function parseMcpError(content: unknown): { code: string; message: string } {
  const text = firstTextContent(content)
  if (!text) return { code: 'MCP_TOOL_ERROR', message: 'Tool call failed.' }
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    if (parsed.error?.message) {
      return {
        code: parsed.error.code ?? 'MCP_TOOL_ERROR',
        message: parsed.error.message
      }
    }
  } catch {
    // fall through to text
  }
  return { code: 'MCP_TOOL_ERROR', message: text }
}

function firstTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const text = content.find(
    (item): item is { type: 'text'; text: string } =>
      item && typeof item === 'object' && 'type' in item && item.type === 'text'
  )
  return text?.text ?? null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
