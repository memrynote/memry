import { describe, it, expect } from 'vitest'
import type { CanvasAssetRow } from '@memry/db-schema'
import { planDereference } from './dedup-plan'

function row(
  overrides: Partial<CanvasAssetRow> & Pick<CanvasAssetRow, 'contentHash' | 'chunkHashes'>
): CanvasAssetRow {
  return {
    vaultId: 'vault-1',
    canvasId: 'canvas-1',
    attachmentId: 'attachment-1',
    fileId: 'file-1',
    filename: 'image.png',
    mimeType: 'image/png',
    sizeBytes: 1234,
    createdAt: 1700000000000,
    ...overrides
  }
}

describe('planDereference', () => {
  it('removes an asset dropped from the scene and dereferences its chunks when no other canvas references it', () => {
    const prevRows = [row({ contentHash: 'hash-a', chunkHashes: ['chunk-1'] })]
    const plan = planDereference(prevRows, new Set(), new Set())
    expect(plan.removedContentHashes).toEqual(['hash-a'])
    expect(plan.dereferencedContentHashes).toEqual(['hash-a'])
    expect(plan.dereferenceChunkHashes).toEqual(['chunk-1'])
  })

  it('removes a dropped asset from this canvas but does not dereference its chunks when another canvas still references it', () => {
    const prevRows = [row({ contentHash: 'hash-a', chunkHashes: ['chunk-1'] })]
    const plan = planDereference(prevRows, new Set(), new Set(['hash-a']))
    expect(plan.removedContentHashes).toEqual(['hash-a'])
    // shared with another canvas → NOT reaped
    expect(plan.dereferencedContentHashes).toEqual([])
    expect(plan.dereferenceChunkHashes).toEqual([])
  })

  it('leaves an asset that is still present in the scene out of both lists', () => {
    const prevRows = [row({ contentHash: 'hash-a', chunkHashes: ['chunk-1'] })]
    const plan = planDereference(prevRows, new Set(['hash-a']), new Set())
    expect(plan.removedContentHashes).toEqual([])
    expect(plan.dereferencedContentHashes).toEqual([])
    expect(plan.dereferenceChunkHashes).toEqual([])
  })

  it('returns an empty plan when nothing changed', () => {
    const prevRows = [
      row({ contentHash: 'hash-a', chunkHashes: ['chunk-1'] }),
      row({ contentHash: 'hash-b', chunkHashes: ['chunk-2'] })
    ]
    const plan = planDereference(prevRows, new Set(['hash-a', 'hash-b']), new Set())
    expect(plan.removedContentHashes).toEqual([])
    expect(plan.dereferencedContentHashes).toEqual([])
    expect(plan.dereferenceChunkHashes).toEqual([])
  })

  it('flattens all chunkHashes of a removed, orphaned asset with multiple chunks', () => {
    const prevRows = [
      row({ contentHash: 'hash-a', chunkHashes: ['chunk-1', 'chunk-2', 'chunk-3'] })
    ]
    const plan = planDereference(prevRows, new Set(), new Set())
    expect(plan.removedContentHashes).toEqual(['hash-a'])
    expect(plan.dereferencedContentHashes).toEqual(['hash-a'])
    expect(plan.dereferenceChunkHashes).toEqual(['chunk-1', 'chunk-2', 'chunk-3'])
  })
})
