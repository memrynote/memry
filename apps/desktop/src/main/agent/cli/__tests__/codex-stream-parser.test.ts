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

  it('extracts fallback messages from Codex error events', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))

    parser.feed(`${JSON.stringify({ type: 'error', error: 'network unavailable' })}\n`)
    parser.feed(`${JSON.stringify({ type: 'error', error: { message: 'model missing' } })}\n`)
    parser.feed(`${JSON.stringify({ type: 'error', error: {} })}\n`)

    expect(events).toEqual([
      { kind: 'error', message: 'network unavailable' },
      { kind: 'error', message: 'model missing' },
      { kind: 'error', message: 'Codex backend reported an error' }
    ])
  })

  it('maps Codex MCP tool call lifecycle events to backend tool events', () => {
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

    expect(events).toEqual([
      {
        kind: 'tool_use',
        toolUseId: 'item_0',
        name: 'vault_list_folder',
        args: { path: 'books', recursive: false }
      },
      {
        kind: 'tool_result',
        toolUseId: 'item_0',
        ok: true,
        data: { content: [] }
      }
    ])
  })

  it('emits failed Codex MCP tool calls as tool results', () => {
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

    expect(events).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'item_0',
        ok: false,
        error: { code: 'MCP_TOOL_ERROR', message: 'user cancelled MCP tool call' }
      }
    ])
  })

  it('extracts fallback errors from failed Codex MCP tool calls', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'mcp_tool_call',
          tool: 'vault_create_task',
          error: { code: 'BAD_REQUEST' },
          status: 'failed'
        }
      })}\n`
    )
    parser.feed(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'mcp_tool_call',
          tool: 'vault_create_task',
          error: 'approval denied',
          status: 'failed'
        }
      })}\n`
    )
    parser.feed(
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'mcp_tool_call',
          tool: 'vault_create_task',
          status: 'failed'
        }
      })}\n`
    )

    expect(events).toEqual([
      {
        kind: 'tool_result',
        toolUseId: 'item_1',
        ok: false,
        error: { code: 'MCP_TOOL_ERROR', message: 'Codex MCP tool call failed' }
      },
      {
        kind: 'tool_result',
        toolUseId: 'item_2',
        ok: false,
        error: { code: 'MCP_TOOL_ERROR', message: 'approval denied' }
      },
      {
        kind: 'tool_result',
        toolUseId: 'item_3',
        ok: false,
        error: { code: 'MCP_TOOL_ERROR', message: 'Codex MCP tool call failed' }
      }
    ])
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

  it('ignores lifecycle noise and preserves unknown JSON events', () => {
    const events: unknown[] = []
    const parser = createCodexStreamParser((event) => events.push(event))

    parser.feed(`${JSON.stringify({ type: 'thread.started' })}\n`)
    parser.feed(`${JSON.stringify({ type: 'turn.started' })}\n`)
    parser.feed(`${JSON.stringify({ type: 'item.completed', item: { type: 'reasoning' } })}\n`)
    parser.feed(`${JSON.stringify({ type: 'unexpected.event', value: 1 })}\n`)

    expect(events).toEqual([
      { kind: 'noop' },
      { kind: 'noop' },
      { kind: 'noop' },
      { kind: 'unknown', raw: { type: 'unexpected.event', value: 1 } }
    ])
  })
})
