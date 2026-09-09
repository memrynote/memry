import { describe, expect, it } from 'vitest'

import { classifyAssetRef } from '../asset-ref'

describe('classifyAssetRef', () => {
  it('treats an https url as remote', () => {
    expect(classifyAssetRef('https://example.com/favicon.ico')).toEqual({
      kind: 'remote',
      url: 'https://example.com/favicon.ico'
    })
  })

  it('treats cleartext http as vault so it never gets fetched', () => {
    expect(classifyAssetRef('http://example.com/favicon.ico')).toEqual({
      kind: 'vault',
      ref: 'http://example.com/favicon.ico'
    })
  })

  it('treats attachment paths as vault', () => {
    expect(classifyAssetRef('attachments/note-1/photo.png')).toEqual({
      kind: 'vault',
      ref: 'attachments/note-1/photo.png'
    })
    expect(classifyAssetRef('../../attachments/note-1/photo.png')).toEqual({
      kind: 'vault',
      ref: '../../attachments/note-1/photo.png'
    })
  })

  it('treats already-renderable schemes as vault', () => {
    expect(classifyAssetRef('data:image/png;base64,AAAA').kind).toBe('vault')
    expect(classifyAssetRef('blob:abc-123').kind).toBe('vault')
  })

  it('treats an empty ref as vault', () => {
    expect(classifyAssetRef('')).toEqual({ kind: 'vault', ref: '' })
  })

  it('treats an unparseable https ref as vault', () => {
    expect(classifyAssetRef('https://').kind).toBe('vault')
  })
})
