import { describe, expect, it } from 'vitest'

import { createAgyStreamParser } from '../agy-stream-parser'
import type { BackendEvent } from '../types'

/**
 * Every line below is a literal transcript captured from `agy 1.2.7` running
 * `--input-format stream-json --output-format stream-json` against an MCP
 * server, so a CLI output-format change fails here instead of silently blanking
 * a turn.
 */
const INIT =
  '{"event":"init","conversation_id":"ce54","init":{"cwd":"/tmp/memry-agy","tools":["call_mcp_tool"],"permission_mode":"request-review"}}'
const TOOL_ACTIVE =
  '{"event":"step_update","step_update":{"conversation_id":"ce54","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{"query":"invoice"},"ServerName":"memry","ToolName":"notes_search"}}}}'
const TOOL_DONE =
  '{"event":"step_update","step_update":{"conversation_id":"ce54","step_index":4,"state":"DONE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{},"ServerName":"memry","ToolName":"notes_search"},"output":"{\\"ok\\":true,\\"value\\":\\"PONG\\"}"}}}'
const TOOL_ERROR =
  '{"event":"step_update","step_update":{"conversation_id":"ce54","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"Arguments":{},"ServerName":"memry","ToolName":"notes_create"},"output":"{\\"code\\":\\"PERMISSION_DENIED\\",\\"message\\":\\"probe denied\\"}","error":{"type":"TOOL_ERROR","message":"{\\"code\\":\\"PERMISSION_DENIED\\",\\"message\\":\\"probe denied\\"}"}}}}'
const THINKING_ONLY =
  '{"event":"step_update","step_update":{"conversation_id":"ce54","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":3.4}}'
const TEXT_ACTIVE =
  '{"event":"step_update","step_update":{"conversation_id":"ce54","step_index":5,"state":"ACTIVE","step_type":"agent_response","text_delta":"Found "}}'
const TEXT_DONE =
  '{"event":"step_update","step_update":{"conversation_id":"ce54","step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"one note.\\n"}}'
const RESULT_SUCCESS =
  '{"event":"result","result":{"conversation_id":"ce54","status":"SUCCESS","response":"Found one note.\\n","num_turns":1}}'
const RESULT_EMPTY =
  '{"event":"result","result":{"conversation_id":"ce54","status":"SUCCESS","response":"","num_turns":1}}'
const RESULT_ERROR =
  '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out"}}'

function collect(lines: string[]): BackendEvent[] {
  const events: BackendEvent[] = []
  const parser = createAgyStreamParser((event) => events.push(event))
  for (const line of lines) parser.feed(`${line}\n`)
  parser.flush()
  return events
}

describe('createAgyStreamParser', () => {
  it('translates a vault tool call, its result and the streamed answer', () => {
    expect(
      collect([INIT, THINKING_ONLY, TOOL_ACTIVE, TOOL_DONE, TEXT_ACTIVE, TEXT_DONE, RESULT_SUCCESS])
    ).toEqual([
      { kind: 'noop' },
      { kind: 'noop' },
      {
        kind: 'tool_use',
        toolUseId: '4',
        name: 'notes_search',
        args: { query: 'invoice' }
      },
      { kind: 'tool_result', toolUseId: '4', ok: true, data: { ok: true, value: 'PONG' } },
      { kind: 'assistant_delta', text: 'Found ' },
      { kind: 'assistant_delta', text: 'one note.\n' },
      { kind: 'message_stop' }
    ])
  })

  it('recovers the vault error code from the string agy flattens a failed call into', () => {
    expect(collect([TOOL_ERROR])).toEqual([
      {
        kind: 'tool_result',
        toolUseId: '2',
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: 'probe denied' }
      }
    ])
  })

  it('reports a successful run that produced no answer as an error', () => {
    // A tool denied by policy does not fail the process: agy exits 0 with
    // SUCCESS and an empty response, explaining itself only on stderr. Passing
    // that through would show the user a blank assistant reply.
    const events = collect([INIT, RESULT_EMPTY])
    expect(events.at(-1)).toMatchObject({ kind: 'error' })
    expect(events.at(-1)).toMatchObject({ message: expect.stringContaining('denied by policy') })
  })

  it('keeps a streamed answer even when the final result body is empty', () => {
    expect(collect([TEXT_ACTIVE, RESULT_EMPTY]).at(-1)).toEqual({ kind: 'message_stop' })
  })

  it('surfaces a non-success result as a backend error', () => {
    expect(collect([RESULT_ERROR])).toEqual([
      { kind: 'error', message: 'authentication failed or timed out' }
    ])
  })

  it('reassembles events split across chunk boundaries', () => {
    const events: BackendEvent[] = []
    const parser = createAgyStreamParser((event) => events.push(event))
    const half = Math.floor(TEXT_ACTIVE.length / 2)
    parser.feed(TEXT_ACTIVE.slice(0, half))
    parser.feed(`${TEXT_ACTIVE.slice(half)}\n`)
    parser.flush()

    expect(events).toEqual([{ kind: 'assistant_delta', text: 'Found ' }])
  })

  it('reports an unparseable line instead of dropping it', () => {
    expect(collect(['not json'])).toEqual([{ kind: 'unknown', raw: 'not json' }])
  })

  it('names non-MCP built-in tools by their own tool name', () => {
    const line =
      '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/x"}}}}'
    expect(collect([line])).toEqual([
      {
        kind: 'tool_use',
        toolUseId: '2',
        name: 'view_file',
        args: { AbsolutePath: '/tmp/x' }
      }
    ])
  })
})
