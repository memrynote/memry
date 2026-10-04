import { describe, expect, it } from 'vitest'

import { TextToolCallSplitter, type TextToolCallSegment } from '../tool-call-profile'

function split(deltas: string[]): TextToolCallSegment[] {
  const splitter = new TextToolCallSplitter(new Set(['vault_get_tags']))
  return [...deltas.flatMap((delta) => splitter.push(delta)), ...splitter.flush()]
}

describe('TextToolCallSplitter', () => {
  it('keeps a call for a tool the turn does not offer as text', () => {
    const quoted = '<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>'

    expect(split(['Syntax: ', quoted])).toEqual([
      { kind: 'text', text: 'Syntax: ' },
      { kind: 'text', text: quoted }
    ])
  })

  it('releases held-back text once it cannot start a tag', () => {
    expect(split(['a <', 'b'])).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'text', text: '<b' }
    ])
  })

  it('accepts parameters as arguments and a call that ends without its closing tag', () => {
    expect(split(['<tool_call>{"name": "vault_get_tags", "parameters": {"limit": 5}}'])).toEqual([
      { kind: 'call', call: { toolName: 'vault_get_tags', input: '{"limit":5}' } }
    ])
  })
})
