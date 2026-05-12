import { describe, expect, it } from 'vitest'

import { createCodexStreamParser } from '../codex-stream-parser'

describe('Codex JSONL stream parser', () => {
  it('emits assistant text from completed agent messages', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'pong' }
      })}\n`
    )

    expect(events).toEqual([{ kind: 'assistant_delta', text: 'pong' }])
  })

  it('treats turn completion as a stop event', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))

    parser.feed(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`)

    expect(events).toEqual([{ kind: 'message_stop' }])
  })

  it('emits backend errors from error events', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))

    parser.feed(`${JSON.stringify({ type: 'error', message: 'Codex auth failed' })}\n`)

    expect(events).toEqual([{ kind: 'error', message: 'Codex auth failed' }])
  })

  it('treats Codex MCP tool call lifecycle events as known events', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'mcp_tool_call',
          server: 'memry',
          tool: 'vault_list_folder',
          arguments: { path: 'books', recursive: false },
          status: 'in_progress'
        }
      })}\n`
    )
    parser.feed(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'mcp_tool_call',
          server: 'memry',
          tool: 'vault_list_folder',
          arguments: { path: 'books', recursive: false },
          result: { content: [] },
          error: null,
          status: 'completed'
        }
      })}\n`
    )

    expect(events).toEqual([{ kind: 'noop' }, { kind: 'noop' }])
  })

  it('emits backend errors from failed Codex MCP tool calls', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'mcp_tool_call',
          server: 'memry',
          tool: 'vault_list_folder',
          error: { message: 'user cancelled MCP tool call' },
          status: 'failed'
        }
      })}\n`
    )

    expect(events).toEqual([{ kind: 'error', message: 'user cancelled MCP tool call' }])
  })

  it('buffers split JSONL lines and preserves malformed lines as unknown', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'split' }
    })

    parser.feed(line.slice(0, 8))
    expect(events).toHaveLength(0)
    parser.feed(`${line.slice(8)}\nnot-json\n`)

    expect(events[0]).toEqual({ kind: 'assistant_delta', text: 'split' })
    expect(events[1]).toMatchObject({ kind: 'unknown' })
  })
})
