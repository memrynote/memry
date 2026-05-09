import { describe, it, expect } from 'vitest'
import { AgentToolError, toMcpToolErrorContent, type AgentToolErrorCode } from '../errors'

describe('AgentToolError', () => {
  it('carries a structured code, message, and details', () => {
    const err = new AgentToolError('NOT_FOUND', 'Note not found', { id: 'abc' })
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBe('Note not found')
    expect(err.details).toEqual({ id: 'abc' })
    expect(err).toBeInstanceOf(Error)
  })

  it('serializes to MCP tool-error content shape', () => {
    const err = new AgentToolError('VALIDATION', 'bad arg')
    const out = toMcpToolErrorContent(err)
    expect(out).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ code: 'VALIDATION', message: 'bad arg', details: undefined })
        }
      ]
    })
  })

  it('coerces unknown errors into INTERNAL', () => {
    const out = toMcpToolErrorContent(new Error('boom'))
    expect(out.isError).toBe(true)
    const payload = JSON.parse(out.content[0].text)
    expect(payload.code).toBe('INTERNAL')
    expect(payload.message).toBe('boom')
  })

  it('exports the union of legal codes', () => {
    const codes: AgentToolErrorCode[] = ['NOT_FOUND', 'PERMISSION_DENIED', 'VALIDATION', 'INTERNAL']
    expect(codes).toHaveLength(4)
  })
})
