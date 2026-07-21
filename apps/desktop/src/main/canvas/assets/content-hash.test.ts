import { describe, it, expect } from 'vitest'
import { hashAssetContent, extForMime, assetFilename } from './content-hash'

describe('hashAssetContent', () => {
  it('returns the same hash for the same bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    expect(hashAssetContent(bytes)).toBe(hashAssetContent(new Uint8Array([1, 2, 3, 4])))
  })

  it('returns a different hash for different bytes', () => {
    const a = hashAssetContent(new Uint8Array([1, 2, 3]))
    const b = hashAssetContent(new Uint8Array([4, 5, 6]))
    expect(a).not.toBe(b)
  })

  it('returns a sha256 hex digest', () => {
    const hash = hashAssetContent(new Uint8Array([1, 2, 3]))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('extForMime', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['image/svg+xml', 'svg']
  ])('maps %s to %s', (mime, ext) => {
    expect(extForMime(mime)).toBe(ext)
  })

  it('falls back to bin for an unknown mime type', () => {
    expect(extForMime('application/octet-stream')).toBe('bin')
  })
})

describe('assetFilename', () => {
  it('joins the content hash and mime-derived extension', () => {
    expect(assetFilename('abc123', 'image/png')).toBe('abc123.png')
  })

  it('falls back to bin for an unknown mime type', () => {
    expect(assetFilename('abc123', 'application/octet-stream')).toBe('abc123.bin')
  })
})
