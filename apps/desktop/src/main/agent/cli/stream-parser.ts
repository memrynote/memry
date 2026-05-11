import type { BackendEvent } from './types'

export interface StreamParser {
  feed(chunk: string): void
  flush(): void
}

export function createStreamParser(onEvent: (event: BackendEvent) => void): StreamParser {
  let buffer = ''

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
        emitLine(line, onEvent)
      }
    },
    flush() {
      if (buffer.trim()) {
        emitLine(buffer, onEvent)
      }
      buffer = ''
    }
  }
}

function emitLine(line: string, onEvent: (event: BackendEvent) => void): void {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    onEvent(translate(obj))
  } catch {
    onEvent({ kind: 'unknown', raw: line })
  }
}

function translate(obj: Record<string, unknown>): BackendEvent {
  const event = unwrapClaudeCodeEvent(obj)
  const type = event.type
  if (type === 'content_block_delta') {
    const delta = event.delta as { type?: string; text?: string } | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { kind: 'assistant_delta', text: delta.text }
    }
  }

  if (type === 'content_block_start') {
    const block = event.content_block as
      | { type?: string; id?: string; name?: string; input?: unknown }
      | undefined
    if (block?.type === 'tool_use' && block.id && block.name) {
      return {
        kind: 'tool_use',
        toolUseId: block.id,
        name: block.name,
        args: block.input ?? {}
      }
    }
    if (block?.type === 'text') {
      return { kind: 'noop' }
    }
  }

  if (type === 'tool_result') {
    const toolUseId = eventId(event.tool_use_id)
    const isError = Boolean(event.is_error)
    const content = event.content as Array<{ type?: string; text?: string }> | undefined
    const text = content?.find((entry) => entry.type === 'text')?.text ?? ''
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

  if (type === 'message_stop') {
    return { kind: 'message_stop' }
  }

  if (type === 'result' && typeof event.result === 'string') {
    return { kind: 'assistant_delta', text: event.result }
  }

  if (
    type === 'system' ||
    type === 'user' ||
    type === 'assistant' ||
    type === 'message_start' ||
    type === 'message_delta' ||
    type === 'content_block_stop'
  ) {
    return { kind: 'noop' }
  }

  return { kind: 'unknown', raw: event }
}

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
