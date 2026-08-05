import { describe, expect, it } from 'vitest'
import { PREFLIGHT_MARK_BINDING_LOADED, PREFLIGHT_MARK_STARTED } from './crdt-preflight-protocol'

/**
 * The child writes these markers to stderr and the parent stages a failure by
 * substring-matching the accumulated stderr (`crdt-preflight.ts`,
 * `stageFromMarkers`). The staging decides whether the user's CRDT store gets
 * quarantined, so the marker strings themselves carry the invariant.
 *
 * `CrdtPreflightStage` is a type-only export — nothing to assert at runtime.
 */
describe('crdt preflight markers', () => {
  const markers = [PREFLIGHT_MARK_STARTED, PREFLIGHT_MARK_BINDING_LOADED]

  it('are distinct', () => {
    expect(PREFLIGHT_MARK_STARTED).not.toBe(PREFLIGHT_MARK_BINDING_LOADED)
  })

  it('never contain one another, so a started-only child cannot stage as "store"', () => {
    // The parent tests binding-loaded FIRST. If binding-loaded were a substring
    // of started, a child that died before touching the native binding would be
    // staged 'store' and a perfectly healthy store would be quarantined.
    expect(PREFLIGHT_MARK_STARTED.includes(PREFLIGHT_MARK_BINDING_LOADED)).toBe(false)
    expect(PREFLIGHT_MARK_BINDING_LOADED.includes(PREFLIGHT_MARK_STARTED)).toBe(false)
  })

  it('are single-line printable ASCII, survivable through a stderr pipe on any platform', () => {
    // The child emits them with writeSync(2, ...) — under a Windows console
    // codepage or a non-UTF-8 locale, anything outside printable ASCII can come
    // back mangled and stop matching.
    for (const marker of markers) {
      expect(marker).toMatch(/^[\x20-\x7e]+$/)
      expect(marker).not.toMatch(/\s/)
    }
  })

  it('are sentinel-shaped so ordinary child stderr never matches by accident', () => {
    for (const marker of markers) {
      expect(marker.startsWith('@@memry-preflight:')).toBe(true)
      expect(marker.endsWith('@@')).toBe(true)
    }

    const realWorldNoise = [
      '[1234:0101/000000.123:ERROR:crashpad_client_win.cc(868)] not connected',
      'IO error: lock /Users/x/Library/Application Support/memry/crdt-store/LOCK: already held',
      'Error: dlopen failed: NODE_MODULE_VERSION mismatch',
      '    at Object.<anonymous> (/app.asar/out/main/crdt-preflight-child.js:12:9)',
      'preflight started; binding loaded'
    ].join('\n')

    for (const marker of markers) {
      expect(realWorldNoise.includes(marker)).toBe(false)
    }
  })
})
