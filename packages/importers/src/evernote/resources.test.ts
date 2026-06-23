import { describe, it, expect } from 'vitest'
import { resourceByHash } from './resources.ts'
import type { EnexResource } from './types.ts'

const fakeHash = (base64: string) => `hash:${base64.slice(0, 4)}`

describe('resourceByHash', () => {
  it('builds a map from hash to resource', () => {
    const resources: EnexResource[] = [
      { base64: 'AAAA', mime: 'image/png', fileName: 'photo.png' },
      { base64: 'BBBB', mime: 'application/pdf', fileName: 'doc.pdf' }
    ]
    const map = resourceByHash(resources, fakeHash)
    expect(map.get('hash:AAAA')).toEqual(resources[0])
    expect(map.get('hash:BBBB')).toEqual(resources[1])
  })

  it('returns empty map for empty resources', () => {
    expect(resourceByHash([], fakeHash).size).toBe(0)
  })

  it('last-write wins for duplicate hashes', () => {
    const r1: EnexResource = { base64: 'AAAA', mime: 'image/png' }
    const r2: EnexResource = { base64: 'AAAA', mime: 'image/jpeg' }
    const map = resourceByHash([r1, r2], fakeHash)
    // Both hash to same key — second wins
    expect(map.get('hash:AAAA')).toEqual(r2)
    expect(map.size).toBe(1)
  })

  it('calls computeHash with the base64 string', () => {
    const calls: string[] = []
    const trackingHash = (b64: string) => {
      calls.push(b64)
      return `h:${b64}`
    }
    const resources: EnexResource[] = [{ base64: 'TEST', mime: 'text/plain' }]
    resourceByHash(resources, trackingHash)
    expect(calls).toEqual(['TEST'])
  })
})
