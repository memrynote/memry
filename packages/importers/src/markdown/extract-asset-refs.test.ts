import { describe, it, expect } from 'vitest'
import { extractAssetRefs } from './extract-asset-refs.ts'

describe('extractAssetRefs', () => {
  it('returns empty for plain text', () => {
    expect(extractAssetRefs('just text')).toEqual([])
  })

  it('extracts relative image ref', () => {
    expect(extractAssetRefs('![alt](img.png)')).toEqual(['img.png'])
  })

  it('extracts relative link ref', () => {
    expect(extractAssetRefs('[file](doc.pdf)')).toEqual(['doc.pdf'])
  })

  it('extracts relative path with subdirectory', () => {
    expect(extractAssetRefs('![](assets/photo.jpg)')).toEqual(['assets/photo.jpg'])
  })

  it('ignores http URLs', () => {
    expect(extractAssetRefs('![](https://example.com/img.png)')).toEqual([])
  })

  it('ignores absolute paths', () => {
    expect(extractAssetRefs('![](/absolute/path.png)')).toEqual([])
  })

  it('ignores wikilinks', () => {
    expect(extractAssetRefs('[[Some Note]]')).toEqual([])
  })

  it('deduplicates repeated refs', () => {
    const body = '![](img.png) and again ![](img.png)'
    expect(extractAssetRefs(body)).toEqual(['img.png'])
  })

  it('returns multiple distinct refs', () => {
    const body = '![](a.png) [link](b.pdf)'
    const refs = extractAssetRefs(body)
    expect(refs).toContain('a.png')
    expect(refs).toContain('b.pdf')
    expect(refs).toHaveLength(2)
  })

  it('ignores mailto: scheme', () => {
    expect(extractAssetRefs('[email](mailto:hi@example.com)')).toEqual([])
  })
})
