import { describe, it, expect } from 'vitest'
import { checkCapabilities, type TauriConfig, type Capability } from './capability-sanity-check'

describe('checkCapabilities', () => {
  it('returns no missing plugins when conf has no plugins section', () => {
    // #given
    const conf: TauriConfig = {}
    const cap: Capability = { identifier: 'default', permissions: ['core:default'] }

    // #when
    const result = checkCapabilities(conf, cap)

    // #then
    expect(result.missing).toEqual([])
    expect(result.pluginCount).toBe(0)
    expect(result.permissionCount).toBe(1)
  })

  it('returns no missing plugins when conf has empty plugins object', () => {
    // #given
    const conf: TauriConfig = { plugins: {} }
    const cap: Capability = { identifier: 'default', permissions: ['core:default'] }

    // #when
    const result = checkCapabilities(conf, cap)

    // #then
    expect(result.missing).toEqual([])
    expect(result.pluginCount).toBe(0)
  })

  it('passes when conf lists sql plugin and capability grants sql:default (string form)', () => {
    // #given
    const conf: TauriConfig = { plugins: { sql: {} } }
    const cap: Capability = {
      identifier: 'default',
      permissions: ['core:default', 'sql:default']
    }

    // #when
    const result = checkCapabilities(conf, cap)

    // #then
    expect(result.missing).toEqual([])
    expect(result.pluginCount).toBe(1)
    expect(result.permissionCount).toBe(2)
  })

  it('passes when capability grants permission via object identifier form', () => {
    // #given
    const conf: TauriConfig = { plugins: { sql: {} } }
    const cap: Capability = {
      identifier: 'default',
      permissions: ['core:default', { identifier: 'sql:allow-execute' }]
    }

    // #when
    const result = checkCapabilities(conf, cap)

    // #then
    expect(result.missing).toEqual([])
  })

  it('reports missing plugin when conf lists sql but capability has no sql:* grant', () => {
    // #given
    const conf: TauriConfig = { plugins: { sql: {} } }
    const cap: Capability = {
      identifier: 'default',
      permissions: ['core:default']
    }

    // #when
    const result = checkCapabilities(conf, cap)

    // #then
    expect(result.missing).toEqual(['sql'])
  })

  it('reports multiple missing plugins in declaration order', () => {
    // #given
    const conf: TauriConfig = { plugins: { sql: {}, fs: {}, http: {} } }
    const cap: Capability = {
      identifier: 'default',
      permissions: ['core:default', 'fs:allow-read']
    }

    // #when
    const result = checkCapabilities(conf, cap)

    // #then
    expect(result.missing).toEqual(['sql', 'http'])
  })

  it('permits over-granting — capability has grants for plugin NOT in conf', () => {
    // #given
    const conf: TauriConfig = {}
    const cap: Capability = {
      identifier: 'default',
      permissions: ['core:default', 'sql:default', 'fs:allow-read']
    }

    // #when
    const result = checkCapabilities(conf, cap)

    // #then
    expect(result.missing).toEqual([])
  })

  it('matches plugin grant prefix exactly — "sqlite" in conf does not match "sql:default"', () => {
    // #given
    const conf: TauriConfig = { plugins: { sqlite: {} } }
    const cap: Capability = {
      identifier: 'default',
      permissions: ['core:default', 'sql:default']
    }

    // #when
    const result = checkCapabilities(conf, cap)

    // #then
    expect(result.missing).toEqual(['sqlite'])
  })
})
