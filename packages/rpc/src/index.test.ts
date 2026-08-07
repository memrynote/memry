import { describe, expect, it } from 'vitest'
import {
  calendarRpc,
  canvasFolderRpc,
  canvasRpc,
  defineDomain,
  defineEvent,
  defineMethod,
  diagnosticsRpc,
  feedbackRpc,
  inboxRpc,
  notesRpc,
  rpcDomains,
  settingsRpc,
  tasksRpc,
  telemetryRpc
} from './index.ts'

const DOMAINS_WITHOUT_EVENTS = new Set(['telemetry', 'feedback', 'diagnostics'])

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
    expect(canvasRpc.name).toBe('canvas')
    expect(canvasFolderRpc.name).toBe('canvasFolder')
    expect(telemetryRpc.name).toBe('telemetry')
    expect(feedbackRpc.name).toBe('feedback')
    expect(diagnosticsRpc.name).toBe('diagnostics')
  })
})

describe('rpcDomains aggregate', () => {
  it('contains exactly the ten known domains in declaration order', () => {
    expect(rpcDomains).toHaveLength(10)
    expect(rpcDomains.map((d) => d.name)).toEqual([
      'notes',
      'tasks',
      'inbox',
      'settings',
      'calendar',
      'canvas',
      'canvasFolder',
      'telemetry',
      'feedback',
      'diagnostics'
    ])
  })

  it('every domain has non-empty method maps', () => {
    for (const domain of rpcDomains) {
      expect(Object.keys(domain.methods).length, `${domain.name}.methods`).toBeGreaterThan(0)
    }
  })

  it('every event-bearing domain has non-empty event maps', () => {
    for (const domain of rpcDomains) {
      if (DOMAINS_WITHOUT_EVENTS.has(domain.name)) continue
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
