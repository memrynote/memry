import { describe, it, expect } from 'vitest'
import type { MemryAssetDescriptor } from '@memry/contracts/canvas-api'
import {
  extractSceneFileRefs,
  contentHashFromRef,
  readMemryAssets,
  writeMemryAssets
} from './memry-assets'

function descriptor(overrides: Partial<MemryAssetDescriptor> = {}): MemryAssetDescriptor {
  return {
    fileId: 'f1',
    attachmentId: 'attachment-1',
    contentHash: 'abc123',
    chunkHashes: ['chunk-1'],
    mimeType: 'image/png',
    sizeBytes: 1234,
    filename: 'abc123.png',
    ...overrides
  }
}

const PRE_M5_SCENE = JSON.stringify({
  type: 'excalidraw',
  elements: [],
  appState: {},
  files: {
    f1: { mimeType: 'image/png', id: 'f1', dataURL: 'data:image/png;base64,AAAA' }
  }
})

describe('writeMemryAssets / readMemryAssets round-trip', () => {
  it('round-trips a descriptor array and preserves the rest of the scene', () => {
    const scene = JSON.stringify({
      type: 'excalidraw',
      elements: [{ id: 'r1', type: 'rectangle' }],
      appState: { zoom: 1 },
      files: { f1: { mimeType: 'image/png', dataURL: 'memry-file://local/x' } }
    })
    const descriptors = [descriptor()]

    const written = writeMemryAssets(scene, descriptors)
    const parsed = JSON.parse(written)

    expect(readMemryAssets(written)).toEqual(descriptors)
    expect(parsed.elements).toEqual([{ id: 'r1', type: 'rectangle' }])
    expect(parsed.appState).toEqual({ zoom: 1 })
    expect(parsed.files).toEqual({ f1: { mimeType: 'image/png', dataURL: 'memry-file://local/x' } })
  })

  it('throws on unparseable scene JSON (callers pass valid scene JSON)', () => {
    expect(() => writeMemryAssets('{not json', [descriptor()])).toThrow()
  })
})

describe('backward compat with pre-M5 base64 scenes', () => {
  it('readMemryAssets returns [] when memryAssets is absent', () => {
    expect(readMemryAssets(PRE_M5_SCENE)).toEqual([])
  })

  it('extractSceneFileRefs returns [] for a data: URI scene (not a memry-file ref)', () => {
    expect(extractSceneFileRefs(PRE_M5_SCENE)).toEqual([])
  })
})

describe('extractSceneFileRefs', () => {
  it('returns only the memry-file:// entries, skipping data: URIs', () => {
    const scene = JSON.stringify({
      type: 'excalidraw',
      elements: [],
      appState: {},
      files: {
        inline: { mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' },
        external: {
          mimeType: 'image/png',
          dataURL: 'memry-file://local/x/attachments/canvas-assets/abc123.png'
        }
      }
    })

    expect(extractSceneFileRefs(scene)).toEqual([
      { fileId: 'external', ref: 'memry-file://local/x/attachments/canvas-assets/abc123.png' }
    ])
  })

  it('returns [] for malformed JSON', () => {
    expect(extractSceneFileRefs('{not json')).toEqual([])
  })

  it('returns [] when files is missing', () => {
    expect(extractSceneFileRefs(JSON.stringify({ type: 'excalidraw' }))).toEqual([])
  })
})

describe('contentHashFromRef', () => {
  it('extracts the content hash from a canvas-asset ref', () => {
    expect(
      contentHashFromRef('memry-file://local/Users/x/attachments/canvas-assets/abc123.png')
    ).toBe('abc123')
  })

  it('extracts the content hash from a Windows-style canvas-asset ref', () => {
    expect(
      contentHashFromRef('memry-file://local/C:/x/attachments/canvas-assets/def456.webp')
    ).toBe('def456')
  })

  it('returns null for a non-canvas-asset memry-file ref', () => {
    expect(contentHashFromRef('memry-file://local/Users/x/attachments/note-1/img.png')).toBeNull()
  })

  it('returns null for a data: URI', () => {
    expect(contentHashFromRef('data:image/png;base64,AAAA')).toBeNull()
  })
})
