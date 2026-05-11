import { describe, expect, it } from 'vitest'

import { createStreamParser } from '../stream-parser'

describe('Claude stream-json parser', () => {
  it('emits assistant_delta for content_block_delta with text_delta', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello ' }
      })}\n`
    )
    parser.feed(
      `${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'world' }
      })}\n`
    )

    expect(events).toEqual([
      { kind: 'assistant_delta', text: 'hello ' },
      { kind: 'assistant_delta', text: 'world' }
    ])
  })

  it('unwraps Claude Code stream_event envelopes', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'wrapped' }
        }
      })}\n`
    )

    expect(events).toEqual([{ kind: 'assistant_delta', text: 'wrapped' }])
  })

  it('handles split-line buffering across feed() calls', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))
    const line = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'split' }
    })

    parser.feed(line.slice(0, 10))
    expect(events).toHaveLength(0)
    parser.feed(`${line.slice(10)}\n`)

    expect(events).toEqual([{ kind: 'assistant_delta', text: 'split' }])
  })

  it('emits tool_use', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          id: 'tu_1',
          name: 'mcp__memry__vault_read_note',
          input: { id: 'n1' }
        }
      })}\n`
    )

    expect(events[0]).toMatchObject({
      kind: 'tool_use',
      toolUseId: 'tu_1',
      name: 'mcp__memry__vault_read_note',
      args: { id: 'n1' }
    })
  })

  it('emits tool_result on success', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'tu_1',
        is_error: false,
        content: [{ type: 'text', text: '{"id":"n1"}' }]
      })}\n`
    )

    expect(events[0]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tu_1',
      ok: true,
      data: { id: 'n1' }
    })
  })

  it('emits tool_result on structured error', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'tool_result',
        tool_use_id: 'tu_2',
        is_error: true,
        content: [{ type: 'text', text: '{"code":"NOT_FOUND","message":"missing"}' }]
      })}\n`
    )

    expect(events[0]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'tu_2',
      ok: false,
      error: { code: 'NOT_FOUND', message: 'missing' }
    })
  })

  it('emits message_stop on stop event', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(`${JSON.stringify({ type: 'message_stop' })}\n`)

    expect(events[0]).toEqual({ kind: 'message_stop' })
  })

  it('emits assistant_delta for Claude Code result text', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'The note was created.'
      })}\n`
    )

    expect(events[0]).toEqual({ kind: 'assistant_delta', text: 'The note was created.' })
  })

  it('does not replay Claude Code final result after streaming partial text', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(
      `${JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: '12 notes in /tech' }
        }
      })}\n`
    )
    parser.feed(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '12 notes in /tech'
      })}\n`
    )

    expect(events).toEqual([
      { kind: 'assistant_delta', text: '12 notes in /tech' },
      { kind: 'noop' }
    ])
  })

  it('ignores known Claude Code lifecycle events', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed(`${JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting' })}\n`)
    parser.feed(`${JSON.stringify({ type: 'message_start', message: { role: 'assistant' } })}\n`)
    parser.feed(
      `${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })}\n`
    )
    parser.feed(`${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n`)
    parser.feed(
      `${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n`
    )

    expect(events).toEqual([
      { kind: 'noop' },
      { kind: 'noop' },
      { kind: 'noop' },
      { kind: 'noop' },
      { kind: 'noop' }
    ])
  })

  it('falls through to unknown for malformed JSON instead of crashing', () => {
    const events: unknown[] = []
    const parser = createStreamParser((event) => events.push(event))

    parser.feed('not json\n')

    expect(events[0]).toMatchObject({ kind: 'unknown' })
  })
})
