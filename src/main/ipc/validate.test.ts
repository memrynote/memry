import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  createValidatedHandler,
  createHandler,
  createStringHandler,
  withErrorHandling
} from './validate'

describe('ipc validate helpers', () => {
  it('createValidatedHandler parses input and returns handler result', async () => {
    const schema = z.object({ name: z.string().min(1) })
    const handler = createValidatedHandler(schema, async (input) => `hi ${input.name}`)

    const result = await handler({} as never, { name: 'Memry' })
    expect(result).toBe('hi Memry')
  })

  it('createValidatedHandler throws on invalid input', async () => {
    const schema = z.object({ count: z.number().int().min(1) })
    const handler = createValidatedHandler(schema, async (input) => input.count)

    await expect(handler({} as never, { count: 0 })).rejects.toThrow('Validation failed')
  })

  it('createHandler wraps no-arg handler', async () => {
    const handler = createHandler(async () => 'ok')
    const result = await handler({} as never)
    expect(result).toBe('ok')
  })

  it('createStringHandler validates string input', async () => {
    const handler = createStringHandler(async (value) => value.toUpperCase())

    const result = await handler({} as never, 'hello')
    expect(result).toBe('HELLO')

    await expect(handler({} as never, 123)).rejects.toThrow('Validation failed')
  })

  it('withErrorHandling returns consistent error responses', async () => {
    const ok = withErrorHandling(async (value: number) => value * 2)
    const okResult = await ok(2)
    expect(okResult).toBe(4)

    const fail = withErrorHandling(async () => {
      throw new Error('boom')
    })

    const failResult = await fail()
    expect(failResult).toEqual({ success: false, error: 'boom' })
  })
})
