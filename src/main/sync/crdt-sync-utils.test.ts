import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { mergeFrontmatterFromCrdt } from './crdt-sync-utils'
import type { NoteFrontmatter } from '../vault/frontmatter'

describe('mergeFrontmatterFromCrdt', () => {
  function createMetaMap(data: Record<string, unknown>): Y.Map<unknown> {
    const doc = new Y.Doc()
    const metaMap = doc.getMap('meta')
    for (const [key, value] of Object.entries(data)) {
      metaMap.set(key, value)
    }
    return metaMap
  }

  const baseFrontmatter: NoteFrontmatter = {
    id: 'note-123',
    title: 'Original Title',
    created: '2024-01-01T00:00:00.000Z',
    modified: '2024-01-01T00:00:00.000Z',
    tags: ['old-tag']
  }

  it('preserves id and created from file frontmatter', () => {
    const metaMap = createMetaMap({ id: 'should-not-override', created: 'should-not-override' })
    const result = mergeFrontmatterFromCrdt(metaMap, baseFrontmatter)

    expect(result.id).toBe('note-123')
    expect(result.created).toBe('2024-01-01T00:00:00.000Z')
  })

  it('updates modified timestamp', () => {
    const metaMap = createMetaMap({})
    const before = Date.now()
    const result = mergeFrontmatterFromCrdt(metaMap, baseFrontmatter)
    const after = Date.now()

    const modified = new Date(result.modified).getTime()
    expect(modified).toBeGreaterThanOrEqual(before)
    expect(modified).toBeLessThanOrEqual(after)
  })

  it('merges title from CRDT', () => {
    const metaMap = createMetaMap({ title: 'Updated Title' })
    const result = mergeFrontmatterFromCrdt(metaMap, baseFrontmatter)

    expect(result.title).toBe('Updated Title')
  })

  it('merges tags from CRDT', () => {
    const metaMap = createMetaMap({ tags: ['new-tag-1', 'new-tag-2'] })
    const result = mergeFrontmatterFromCrdt(metaMap, baseFrontmatter)

    expect(result.tags).toEqual(['new-tag-1', 'new-tag-2'])
  })

  it('merges aliases from CRDT', () => {
    const metaMap = createMetaMap({ aliases: ['alias1', 'alias2'] })
    const result = mergeFrontmatterFromCrdt(metaMap, baseFrontmatter)

    expect(result.aliases).toEqual(['alias1', 'alias2'])
  })

  it('merges emoji from CRDT', () => {
    const metaMap = createMetaMap({ emoji: '🎉' })
    const result = mergeFrontmatterFromCrdt(metaMap, baseFrontmatter)

    expect(result.emoji).toBe('🎉')
  })

  it('merges properties from CRDT', () => {
    const metaMap = createMetaMap({ properties: { status: 'done', priority: 'high' } })
    const result = mergeFrontmatterFromCrdt(metaMap, baseFrontmatter)

    expect(result.properties).toEqual({ status: 'done', priority: 'high' })
  })

  it('deletes key when CRDT value is null (tombstone)', () => {
    const frontmatterWithTags: NoteFrontmatter = {
      ...baseFrontmatter,
      tags: ['tag1', 'tag2']
    }
    const metaMap = createMetaMap({ tags: null })
    const result = mergeFrontmatterFromCrdt(metaMap, frontmatterWithTags)

    expect(result.tags).toBeUndefined()
  })

  it('preserves file-only keys not in CRDT', () => {
    const frontmatterWithCustom: NoteFrontmatter = {
      ...baseFrontmatter,
      customField: 'custom-value'
    }
    const metaMap = createMetaMap({ title: 'New Title' })
    const result = mergeFrontmatterFromCrdt(metaMap, frontmatterWithCustom)

    expect(result.customField).toBe('custom-value')
    expect(result.title).toBe('New Title')
  })

  it('preserves file values when CRDT value is undefined', () => {
    const metaMap = createMetaMap({})
    const result = mergeFrontmatterFromCrdt(metaMap, baseFrontmatter)

    expect(result.title).toBe('Original Title')
    expect(result.tags).toEqual(['old-tag'])
  })
})
