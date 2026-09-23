import type { BackendEvent } from './types'

export interface AgyStreamParser {
  feed(chunk: string): void
  flush(): void
}

/**
 * Translate Antigravity CLI's `--output-format stream-json` NDJSON into backend
 * events.
 *
 * Shape of the stream (verified against agy 1.2.7):
 *
 *   {"event":"init","init":{"cwd":…,"tools":[…],"permission_mode":"request-review"}}
 *   {"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE",
 *     "step_type":"tool","tool_name":"call_mcp_tool",
 *     "tool_info":{"parameters":{"ServerName":"memry","ToolName":"notes_search",
 *     "Arguments":{…}}}}}
 *   {"event":"step_update","step_update":{…,"state":"DONE","tool_info":{…,"output":"…"}}}
 *   {"event":"step_update","step_update":{…,"step_type":"agent_response","text_delta":"…"}}
 *   {"event":"result","result":{"status":"SUCCESS","response":"…"}}
 *
 * Two traits drive the translation. Steps carry no tool id, so `step_index`
 * doubles as one: a tool's ACTIVE and DONE updates share it. And a tool denied
 * by policy does not fail the run — agy exits 0 with `status:"SUCCESS"` and an
 * empty response, explaining itself only on stderr — so a successful result
 * that produced no text is reported as an error rather than as a blank reply.
 */
export function createAgyStreamParser(onEvent: (event: BackendEvent) => void): AgyStreamParser {
  let buffer = ''
  let emittedAssistantText = false

  const emitBufferedLine = (line: string): void => {
    const event = parseLine(line, emittedAssistantText)
    if (event.kind === 'assistant_delta') emittedAssistantText = true
    onEvent(event)
  }

  return {
    feed(chunk) {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        emitBufferedLine(line)
      }
    },
    flush() {
      if (buffer.trim()) {
        emitBufferedLine(buffer)
      }
      buffer = ''
    }
  }
}

function parseLine(line: string, emittedAssistantText: boolean): BackendEvent {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    return translate(obj, emittedAssistantText)
  } catch {
    return { kind: 'unknown', raw: line }
  }
}

function translate(obj: Record<string, unknown>, emittedAssistantText: boolean): BackendEvent {
  if (obj.event === 'init') return { kind: 'noop' }

  if (obj.event === 'step_update' && isRecord(obj.step_update)) {
    return translateStep(obj.step_update)
  }

  if (obj.event === 'result' && isRecord(obj.result)) {
    return translateResult(obj.result, emittedAssistantText)
  }

  return { kind: 'unknown', raw: obj }
}

function translateStep(step: Record<string, unknown>): BackendEvent {
  if (step.step_type === 'agent_response') {
    // A thinking-only step reports no text at all; only deltas are content.
    return typeof step.text_delta === 'string' && step.text_delta.length > 0
      ? { kind: 'assistant_delta', text: step.text_delta }
      : { kind: 'noop' }
  }

  if (step.step_type !== 'tool') return { kind: 'noop' }

  const toolUseId = stepId(step.step_index)
  const info = isRecord(step.tool_info) ? step.tool_info : {}
  const params = isRecord(info.parameters) ? info.parameters : {}
  const isMcpCall = step.tool_name === 'call_mcp_tool'
  // For a vault call the interesting name is the tool the agent asked for, not
  // the generic `call_mcp_tool` wrapper. It arrives unprefixed, which is
  // already the normalised form the rest of the runtime expects.
  const name = isMcpCall
    ? typeof params.ToolName === 'string'
      ? params.ToolName
      : 'call_mcp_tool'
    : typeof step.tool_name === 'string'
      ? step.tool_name
      : ''
  const args = isMcpCall ? (params.Arguments ?? {}) : params

  if (step.state === 'ACTIVE') {
    return { kind: 'tool_use', toolUseId, name, args }
  }

  if (step.state === 'ERROR' || step.state === 'FAILED' || step.state === 'CANCELLED') {
    return { kind: 'tool_result', toolUseId, ok: false, error: toolError(info) }
  }

  if (step.state === 'DONE') {
    return { kind: 'tool_result', toolUseId, ok: true, data: parseOutput(info.output) }
  }

  return { kind: 'noop' }
}

function translateResult(
  result: Record<string, unknown>,
  emittedAssistantText: boolean
): BackendEvent {
  if (result.status !== 'SUCCESS') {
    return { kind: 'error', message: resultError(result) }
  }

  const response = typeof result.response === 'string' ? result.response : ''
  if (!emittedAssistantText && !response.trim()) {
    return {
      kind: 'error',
      message:
        'Antigravity CLI produced no answer. A tool it needed was denied by policy — check `agy` permissions, then try again.'
    }
  }

  // The deltas already carry the whole response; re-emitting it here would
  // duplicate the reply.
  return { kind: 'message_stop' }
}

function toolError(info: Record<string, unknown>): { code: string; message: string } {
  const raw = isRecord(info.error)
    ? typeof info.error.message === 'string'
      ? info.error.message
      : ''
    : typeof info.error === 'string'
      ? info.error
      : typeof info.output === 'string'
        ? info.output
        : ''

  // Vault tools report failures as a JSON body, so the real code survives
  // agy's flattening of the MCP result into a plain string.
  const parsed = parseOutput(raw)
  if (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message.trim()) {
    return {
      code: typeof parsed.code === 'string' ? parsed.code : 'TOOL_ERROR',
      message: parsed.message
    }
  }

  return { code: 'TOOL_ERROR', message: raw.trim() || 'Antigravity CLI tool call failed' }
}

function resultError(result: Record<string, unknown>): string {
  if (typeof result.error === 'string' && result.error.trim()) return result.error
  if (isRecord(result.error) && typeof result.error.message === 'string') {
    return result.error.message
  }
  const status = typeof result.status === 'string' ? result.status : 'unknown'
  return `Antigravity CLI reported status ${status}`
}

/** agy flattens an MCP result's text content into a string; recover the JSON. */
function parseOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output ?? null
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function stepId(value: unknown): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
