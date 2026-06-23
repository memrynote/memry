import { describe, it, expect, beforeEach } from 'vitest'
import { createWidget, registerWidget, WIDGET_REGISTRY } from './widget-registry'

const fakeDef = {
  type: 'recently-edited' as const,
  titleKey: 'Fake',
  icon: 'clock',
  sizes: ['M'] as const,
  defaultSize: 'M' as const,
  defaultConfig: { seed: 1 },
  Component: () => null
}

describe('widget-registry', () => {
  beforeEach(() => {
    for (const k of Object.keys(WIDGET_REGISTRY)) delete WIDGET_REGISTRY[k]
    registerWidget(fakeDef)
  })

  it('createWidget builds an instance from a registered type', () => {
    const inst = createWidget('recently-edited')
    expect(inst.type).toBe('recently-edited')
    expect(inst.size).toBe('M')
    expect(inst.config).toEqual({ seed: 1 })
    expect(inst.id).toEqual(expect.any(String))
  })
  it('createWidget returns a fresh config object (not the registry reference)', () => {
    expect(createWidget('recently-edited').config).not.toBe(fakeDef.defaultConfig)
  })
  it('createWidget throws for an unknown type', () => {
    expect(() => createWidget('nope' as never)).toThrow()
  })
})
