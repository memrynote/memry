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
  const type = obj.type
  if (type === 'content_block_delta') {
    const delta = obj.delta as { type?: string; text?: string } | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { kind: 'assistant_delta', text: delta.text }
    }
  }

  if (type === 'content_block_start') {
    const block = obj.content_block as
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
  }

  if (type === 'tool_result') {
    const toolUseId = String(obj.tool_use_id ?? '')
    const isError = Boolean(obj.is_error)
    const content = obj.content as Array<{ type?: string; text?: string }> | undefined
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

  return { kind: 'unknown', raw: obj }
}
