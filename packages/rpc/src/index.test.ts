import { describe, expect, it } from 'vitest'
import {
  calendarRpc,
  defineDomain,
  defineEvent,
  defineMethod,
  inboxRpc,
  notesRpc,
  rpcDomains,
  settingsRpc,
  tasksRpc
} from './index.ts'

describe('@memry/rpc public surface', () => {
  it('re-exports the schema factories', () => {
    expect(defineMethod).toBeTypeOf('function')
    expect(defineEvent).toBeTypeOf('function')
    expect(defineDomain).toBeTypeOf('function')
  })

  it('re-exports every domain spec', () => {
    expect(notesRpc.name).toBe('notes')
    expect(tasksRpc.name).toBe('tasks')
    expect(inboxRpc.name).toBe('inbox')
    expect(settingsRpc.name).toBe('settings')
    expect(calendarRpc.name).toBe('calendar')
  })
})

describe('rpcDomains aggregate', () => {
  it('contains exactly the five known domains in declaration order', () => {
    expect(rpcDomains).toHaveLength(5)
    expect(rpcDomains.map((d) => d.name)).toEqual([
      'notes',
      'tasks',
      'inbox',
      'settings',
      'calendar'
    ])
  })

  it('every domain has non-empty method and event maps (except calendar events minimal)', () => {
    for (const domain of rpcDomains) {
      expect(Object.keys(domain.methods).length, `${domain.name}.methods`).toBeGreaterThan(0)
      expect(Object.keys(domain.events).length, `${domain.name}.events`).toBeGreaterThan(0)
    }
  })

  it('method channels are globally unique across domains', () => {
    const all = rpcDomains.flatMap((d) =>
      Object.values(d.methods).map((m) => `${d.name}.${m.channel}`)
    )
    const channelsOnly = rpcDomains.flatMap((d) => Object.values(d.methods).map((m) => m.channel))
    expect(new Set(channelsOnly).size, `duplicate channels in ${all.join(', ')}`).toBe(
      channelsOnly.length
    )
  })

  it('event channels are globally unique across domains', () => {
    const channels = rpcDomains.flatMap((d) => Object.values(d.events).map((e) => e.channel))
    expect(new Set(channels).size).toBe(channels.length)
  })
})
