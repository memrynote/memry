import { describe, expect, it } from 'vitest'
import { defineDomain, defineEvent, defineMethod } from './schema.ts'

describe('defineMethod', () => {
  it('fills defaults when only channel is provided', () => {
    const spec = defineMethod<() => Promise<void>>({ channel: 'x:do' })

    expect(spec.channel).toBe('x:do')
    expect(spec.params).toEqual([])
    expect(spec.invokeArgs).toEqual([])
    expect(spec.mode).toBe('invoke')
    expect(spec.implementation).toBeUndefined()
  })

  it('derives invokeArgs from params when invokeArgs is omitted', () => {
    const spec = defineMethod<(id: string) => Promise<void>>({
      channel: 'x:do',
      params: ['id']
    })

    expect(spec.params).toEqual(['id'])
    expect(spec.invokeArgs).toEqual(['id'])
  })

  it('keeps invokeArgs independent when explicitly provided', () => {
    const spec = defineMethod<(a: string, b: number) => Promise<void>>({
      channel: 'x:do',
      params: ['a', 'b'],
      invokeArgs: ['{ a, b }']
    })

    expect(spec.params).toEqual(['a', 'b'])
    expect(spec.invokeArgs).toEqual(['{ a, b }'])
  })

  it('supports sync mode with implementation template', () => {
    const implementation = '() => invokeSync("x:get-sync")'
    const spec = defineMethod<() => string>({
      channel: 'x:get-sync',
      mode: 'sync',
      implementation
    })

    expect(spec.mode).toBe('sync')
    expect(spec.implementation).toBe(implementation)
  })

  it('preserves readonly param arrays without copying', () => {
    const params = ['id', 'options'] as const
    const spec = defineMethod<(id: string, options: object) => Promise<void>>({
      channel: 'x:do',
      params
    })

    expect(spec.params).toBe(params)
  })
})

describe('defineEvent', () => {
  it('returns a spec with only the channel populated', () => {
    const spec = defineEvent<{ id: string }>('x:created')

    expect(spec.channel).toBe('x:created')
    expect(Object.keys(spec)).toEqual(['channel'])
  })

  it('produces distinct specs for distinct channels', () => {
    const a = defineEvent<void>('x:a')
    const b = defineEvent<void>('x:b')

    expect(a).not.toBe(b)
    expect(a.channel).not.toBe(b.channel)
  })
})

describe('defineDomain', () => {
  it('returns the exact domain object passed in (identity)', () => {
    const domain = {
      name: 'x' as const,
      methods: {
        ping: defineMethod<() => Promise<void>>({ channel: 'x:ping' })
      },
      events: {
        onPong: defineEvent<void>('x:pong')
      }
    }

    const result = defineDomain(domain)

    expect(result).toBe(domain)
    expect(result.name).toBe('x')
    expect(result.methods.ping.channel).toBe('x:ping')
    expect(result.events.onPong.channel).toBe('x:pong')
  })

  it('supports empty method and event maps', () => {
    const domain = defineDomain({
      name: 'empty' as const,
      methods: {},
      events: {}
    })

    expect(domain.name).toBe('empty')
    expect(Object.keys(domain.methods)).toHaveLength(0)
    expect(Object.keys(domain.events)).toHaveLength(0)
  })
})
