import type { BackendEvent } from './types'

export interface StreamParser {
  feed(chunk: string): void
  flush(): void
}

export function createStreamParser(onEvent: (event: BackendEvent) => void): StreamParser {
  let buffer = ''
  let emittedAssistantText = false

  const emitBufferedLine = (line: string): void => {
    for (const event of parseLine(line, emittedAssistantText)) {
      if (event.kind === 'assistant_delta') {
        emittedAssistantText = true
      }
      onEvent(event)
    }
  }

  return {
    feed(chunk) {
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) {
          continue
        }
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

function parseLine(line: string, emittedAssistantText: boolean): BackendEvent[] {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    return translate(obj, emittedAssistantText)
  } catch {
    return [{ kind: 'unknown', raw: line }]
  }
}

function translate(obj: Record<string, unknown>, emittedAssistantText: boolean): BackendEvent[] {
  // Claude Code delivers tool results inside user-role messages, not as
  // top-level tool_result events — without this, no tool result is ever seen.
  if (obj.type === 'user') {
    return toolResultsFromUserMessage(obj)
  }
  if (obj.type === 'assistant') {
    return toolUsesFromAssistantMessage(obj)
  }
  return [translateSingle(obj, emittedAssistantText)]
}

// The streamed `content_block_start` opens a tool call with `input: {}` and the
// arguments follow as `input_json_delta` fragments. The complete message
// repeats each call with its full input, so the call is re-emitted from here:
// the early one lets the UI show the call while its arguments stream, this one
// fills them in. Without partial messages this is the only tool_use there is.
function toolUsesFromAssistantMessage(obj: Record<string, unknown>): BackendEvent[] {
  const message = isRecord(obj.message) ? obj.message : obj
  const content = message.content
  if (!Array.isArray(content)) return [{ kind: 'noop' }]

  const events: BackendEvent[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue
    if (typeof block.id !== 'string' || typeof block.name !== 'string') continue
    events.push({
      kind: 'tool_use',
      toolUseId: block.id,
      name: block.name,
      args: block.input ?? {}
    })
  }
  return events.length > 0 ? events : [{ kind: 'noop' }]
}

function toolResultsFromUserMessage(obj: Record<string, unknown>): BackendEvent[] {
  const message = isRecord(obj.message) ? obj.message : obj
  const content = message.content
  if (!Array.isArray(content)) return [{ kind: 'noop' }]

  const events: BackendEvent[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue
    events.push(toolResultEvent(block))
  }
  return events.length > 0 ? events : [{ kind: 'noop' }]
}

function toolResultEvent(event: Record<string, unknown>): BackendEvent {
  const toolUseId = eventId(event.tool_use_id)
  const isError = Boolean(event.is_error)
  const content = event.content
  const text = Array.isArray(content)
    ? ((content as Array<{ type?: string; text?: string }>).find((entry) => entry.type === 'text')
        ?.text ?? '')
    : typeof content === 'string'
      ? content
      : ''
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }

  if (isError) {
    const errorPayload =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { code?: string; message?: string })
        : null
    return {
      kind: 'tool_result',
      toolUseId,
      ok: false,
      error: {
        code: errorPayload?.code ?? 'INTERNAL',
        message: errorPayload?.message ?? text
      }
    }
  }

  return { kind: 'tool_result', toolUseId, ok: true, data: parsed }
}

function translateSingle(
  obj: Record<string, unknown>,
  emittedAssistantText: boolean
): BackendEvent {
  const event = unwrapClaudeCodeEvent(obj)
  const type = event.type
  if (type === 'content_block_delta') {
    const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { kind: 'assistant_delta', text: delta.text }
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return { kind: 'reasoning_delta', text: delta.thinking, startsBlock: false }
    }
    // Tool arguments are taken whole from the `assistant` message instead of
    // reassembled here. As `unknown` these logged once per fragment, note
    // content in `partial_json` included.
    if (delta?.type && ignoredDeltaTypes.has(delta.type)) {
      return { kind: 'noop' }
    }
  }

  if (type === 'content_block_start') {
    const block = event.content_block as
      { type?: string; id?: string; name?: string; input?: unknown; thinking?: unknown } | undefined
    if (block?.type === 'tool_use' && block.id && block.name) {
      return {
        kind: 'tool_use',
        toolUseId: block.id,
        name: block.name,
        args: block.input ?? {}
      }
    }
    // Thinking arrives as deltas; the opening block only marks the boundary.
    // `redacted_thinking` carries no readable text and stays ignored.
    if (block?.type === 'thinking') {
      return {
        kind: 'reasoning_delta',
        text: typeof block.thinking === 'string' ? block.thinking : '',
        startsBlock: true
      }
    }
    if (block?.type && ignoredBlockTypes.has(block.type)) {
      return { kind: 'noop' }
    }
  }

  if (type === 'tool_result') {
    return toolResultEvent(event)
  }

  if (type === 'message_stop') {
    return { kind: 'message_stop' }
  }

  if (type === 'result' && typeof event.result === 'string') {
    if (emittedAssistantText) return { kind: 'noop' }
    return { kind: 'assistant_delta', text: event.result }
  }

  if (
    type === 'system' ||
    type === 'message_start' ||
    type === 'message_delta' ||
    type === 'content_block_stop' ||
    type === 'tool_progress' ||
    type === 'rate_limit_event'
  ) {
    return { kind: 'noop' }
  }

  return { kind: 'unknown', raw: event }
}

const ignoredDeltaTypes = new Set(['input_json_delta', 'signature_delta'])
const ignoredBlockTypes = new Set(['text', 'redacted_thinking'])

function unwrapClaudeCodeEvent(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj.type !== 'stream_event' || !isRecord(obj.event)) return obj
  return obj.event
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function eventId(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}
