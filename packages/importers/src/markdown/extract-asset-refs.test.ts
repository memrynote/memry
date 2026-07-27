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

  it('skips links to other markdown notes', () => {
    expect(extractAssetRefs('[link](../root-note.md)')).toEqual([])
    expect(extractAssetRefs('[link](notes/other.markdown)')).toEqual([])
    expect(extractAssetRefs('[link](../root-note.md#heading)')).toEqual([])
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

  describe('obsidian embeds', () => {
    it('extracts an image embed', () => {
      expect(extractAssetRefs('![[photo.png]]')).toEqual(['photo.png'])
    })

    it('extracts an embed carrying a display size', () => {
      expect(extractAssetRefs('![[photo.png|300x200]]')).toEqual(['photo.png'])
    })

    it('extracts an embed carrying an alias', () => {
      expect(extractAssetRefs('![[photo.png|My photo]]')).toEqual(['photo.png'])
    })

    it('extracts an embed with a subfolder path', () => {
      expect(extractAssetRefs('![[Images/Media/shared.png]]')).toEqual(['Images/Media/shared.png'])
    })

    it('extracts an embed with a parent-relative path', () => {
      expect(extractAssetRefs('![[../Images/shared.png]]')).toEqual(['../Images/shared.png'])
    })

    it('strips an anchor from a non-image embed', () => {
      expect(extractAssetRefs('![[report.pdf#page=3]]')).toEqual(['report.pdf'])
    })

    it('extracts an embed sitting inline in a sentence', () => {
      expect(extractAssetRefs('see ![[photo.png]] here')).toEqual(['photo.png'])
    })

    it('extracts every distinct embed on one line', () => {
      expect(extractAssetRefs('![[a.png]] ![[b.jpg]]')).toEqual(['a.png', 'b.jpg'])
    })

    it('ignores a note transclusion with no extension', () => {
      expect(extractAssetRefs('![[Some Note]]')).toEqual([])
    })

    it('ignores a markdown transclusion', () => {
      expect(extractAssetRefs('![[Some Note.md]]')).toEqual([])
    })

    it('ignores a heading transclusion', () => {
      expect(extractAssetRefs('![[Some Note#Heading]]')).toEqual([])
    })

    it('ignores a plain wikilink with no bang', () => {
      expect(extractAssetRefs('[[photo.png]]')).toEqual([])
    })

    it('ignores an absolute embed path', () => {
      expect(extractAssetRefs('![[/absolute/photo.png]]')).toEqual([])
    })

    it('deduplicates the same asset across both syntaxes', () => {
      expect(extractAssetRefs('![[img.png]] and ![](img.png)')).toEqual(['img.png'])
    })
  })
})
