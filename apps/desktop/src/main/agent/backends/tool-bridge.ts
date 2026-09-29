import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolSet } from 'ai'

import { createLogger } from '../../lib/logger'
import { trackMainError } from '../../telemetry/diagnostics'
import { ALL_TOOL_NAMES, TOOL_SCHEMAS, type ToolName } from '../mcp/tools/schemas'
import type { TurnWriteGrant } from '../turn-grants'

const logger = createLogger('AgentToolBridge')

// A write tool call holds its MCP request open while the runtime waits for the
// user's approval, and that wait is bounded by the runtime's 30-minute approval
// deadline (APPROVAL_TIMEOUT_MS in runtime/runtime.ts). The SDK's default
// 60s request timeout fired first: the model was told the call failed with
// `McpError -32001 Request timed out` while the approval card was still on
// screen, and approving it afterwards ran the write anyway (#2524). One minute
// of margin lets the runtime's own expiry answer before the client gives up.
export const VAULT_TOOL_CALL_TIMEOUT_MS = 31 * 60 * 1000

export interface AgentToolCallInput {
  writeGrant: TurnWriteGrant
  windowId: string
  name: ToolName
  args: unknown
}

export type AgentToolCallResult =
  { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }

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
  ctx: { writeGrant: TurnWriteGrant; windowId: string }
): ToolSet {
  const tools: ToolSet = {}
  for (const name of ALL_TOOL_NAMES) {
    const schema = TOOL_SCHEMAS[name]
    tools[name] = {
      description: schema.description,
      inputSchema: schema.input,
      execute: async (args: unknown) =>
        bridge.execute({
          writeGrant: ctx.writeGrant,
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
        'X-Memry-Turn': input.writeGrant,
        'X-Memry-Window': input.windowId
      }
    }
  })
  const client = new Client({ name: 'memry-agent-local', version: '1.0.0' })

  try {
    await client.connect(transport)
    const result = await client.callTool(
      {
        name: input.name,
        arguments: toRecord(input.args)
      },
      undefined,
      { timeout: VAULT_TOOL_CALL_TIMEOUT_MS }
    )
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

type McpErrorPayload = { code?: unknown; message?: unknown }

// The Vault MCP server writes `{ code, message, details }` at the top level
// (toMcpToolErrorContent). Reading only a nested `{ error: {...} }` turned every
// server failure, PERMISSION_DENIED included, into `MCP_TOOL_ERROR` with the raw
// JSON as its message. The nested shape is still accepted for other servers.
function parseMcpError(content: unknown): { code: string; message: string } {
  const text = firstTextContent(content)
  if (!text) return { code: 'MCP_TOOL_ERROR', message: 'Tool call failed.' }
  try {
    const parsed = JSON.parse(text) as (McpErrorPayload & { error?: McpErrorPayload }) | null
    const payload = parsed?.error ?? parsed
    if (payload && typeof payload.message === 'string' && payload.message) {
      return {
        code: typeof payload.code === 'string' && payload.code ? payload.code : 'MCP_TOOL_ERROR',
        message: payload.message
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
