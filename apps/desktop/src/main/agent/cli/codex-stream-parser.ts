import type { BackendEvent } from './types'

export interface CodexStreamParser {
  feed(chunk: string): void
  flush(): void
}

export function createCodexStreamParser(onEvent: (event: BackendEvent) => void): CodexStreamParser {
  let buffer = ''

  const emitBufferedLine = (line: string): void => {
    onEvent(parseLine(line))
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

function parseLine(line: string): BackendEvent {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    return translate(obj)
  } catch {
    return { kind: 'unknown', raw: line }
  }
}

function translate(obj: Record<string, unknown>): BackendEvent {
  if (isMcpToolCallEvent(obj)) {
    if (obj.type === 'item.completed' && isRecord(obj.item)) {
      const errorMessage = extractMcpToolErrorMessage(obj.item)
      if (errorMessage) {
        return { kind: 'error', message: errorMessage }
      }
    }
    return { kind: 'noop' }
  }

  if (obj.type === 'item.completed' && isRecord(obj.item)) {
    if (obj.item.type === 'agent_message' && typeof obj.item.text === 'string') {
      return { kind: 'assistant_delta', text: obj.item.text }
    }
    return { kind: 'noop' }
  }

  if (obj.type === 'turn.completed') {
    return { kind: 'message_stop' }
  }

  if (obj.type === 'error') {
    return { kind: 'error', message: extractErrorMessage(obj) }
  }

  if (obj.type === 'thread.started' || obj.type === 'turn.started') {
    return { kind: 'noop' }
  }

  return { kind: 'unknown', raw: obj }
}

function isMcpToolCallEvent(obj: Record<string, unknown>): boolean {
  return (
    (obj.type === 'item.started' || obj.type === 'item.completed') &&
    isRecord(obj.item) &&
    obj.item.type === 'mcp_tool_call'
  )
}

function extractMcpToolErrorMessage(item: Record<string, unknown>): string | null {
  if (item.status !== 'failed') return null

  if (isRecord(item.error)) {
    if (typeof item.error.message === 'string' && item.error.message.trim()) {
      return item.error.message
    }
    return 'Codex MCP tool call failed'
  }

  if (typeof item.error === 'string' && item.error.trim()) {
    return item.error
  }

  return 'Codex MCP tool call failed'
}

function extractErrorMessage(obj: Record<string, unknown>): string {
  if (typeof obj.message === 'string' && obj.message.trim()) {
    return obj.message
  }

  if (typeof obj.error === 'string' && obj.error.trim()) {
    return obj.error
  }

  if (isRecord(obj.error) && typeof obj.error.message === 'string' && obj.error.message.trim()) {
    return obj.error.message
  }

  return 'Codex backend reported an error'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
