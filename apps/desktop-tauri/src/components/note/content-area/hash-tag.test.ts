import { describe, it, expect } from 'vitest'
import { extractInlineTags } from './hash-tag'
import type { Block } from '@blocknote/core'

function textBlock(content: Array<Record<string, unknown> | string>): Block {
  return { type: 'paragraph', content, children: [], id: 'b1', props: {} } as unknown as Block
}

function hashTagItem(tag: string, color = 'stone') {
  return { type: 'hashTag', props: { tag, color } }
}

function textItem(text: string) {
  return { type: 'text', text, styles: {} }
}

describe('extractInlineTags', () => {
  describe('hashTag inline content (existing behavior)', () => {
    it('extracts hashTag inline content nodes', () => {
      const blocks = [textBlock([hashTagItem('typescript')])]
      expect(extractInlineTags(blocks)).toEqual(['typescript'])
    })

    it('normalizes hashTag props to lowercase', () => {
      const blocks = [textBlock([hashTagItem('TypeScript')])]
      expect(extractInlineTags(blocks)).toEqual(['typescript'])
    })

    it('deduplicates across blocks', () => {
      const blocks = [textBlock([hashTagItem('react')]), textBlock([hashTagItem('React')])]
      expect(extractInlineTags(blocks)).toEqual(['react'])
    })
  })

  describe('plain text #tag detection (paste support)', () => {
    it('extracts #tags from text content items', () => {
      const blocks = [textBlock([textItem('hello #world and #typescript')])]
      expect(extractInlineTags(blocks)).toEqual(['world', 'typescript'])
    })

    it('extracts #tags from raw string content items', () => {
      const blocks = [textBlock(['hello #pasted tag' as unknown as Record<string, unknown>])]
      expect(extractInlineTags(blocks)).toEqual(['pasted'])
    })

    it('ignores tags preceded by non-whitespace', () => {
      const blocks = [textBlock([textItem('email@#notag but #real')])]
      expect(extractInlineTags(blocks)).toEqual(['real'])
    })

    it('accepts tags at start of text', () => {
      const blocks = [textBlock([textItem('#first word')])]
      expect(extractInlineTags(blocks)).toEqual(['first'])
    })

    it('normalizes text tags to lowercase', () => {
      const blocks = [textBlock([textItem('#URGENT')])]
      expect(extractInlineTags(blocks)).toEqual(['urgent'])
    })

    it('deduplicates text tags with hashTag nodes', () => {
      const blocks = [textBlock([hashTagItem('react'), textItem(' and also #react here')])]
      expect(extractInlineTags(blocks)).toEqual(['react'])
    })

    it('handles tags with hyphens and underscores', () => {
      const blocks = [textBlock([textItem('#my-tag and #my_tag')])]
      expect(extractInlineTags(blocks)).toEqual(['my-tag', 'my_tag'])
    })

    it('extracts tags starting with a digit', () => {
      const blocks = [textBlock([textItem('#123invalid and #valid')])]
      expect(extractInlineTags(blocks)).toEqual(['123invalid', 'valid'])
    })

    it('extracts pure numeric tags', () => {
      const blocks = [textBlock([textItem('#2024 goals')])]
      expect(extractInlineTags(blocks)).toEqual(['2024'])
    })
  })

  describe('block type filtering', () => {
    it('skips codeBlock content', () => {
      const blocks = [
        { type: 'codeBlock', content: [textItem('#notag')], children: [], id: 'c1', props: {} }
      ] as unknown as Block[]
      expect(extractInlineTags(blocks)).toEqual([])
    })

    it('walks nested children', () => {
      const parent = {
        type: 'paragraph',
        content: [],
        id: 'p1',
        props: {},
        children: [textBlock([textItem('#nested')])]
      } as unknown as Block
      expect(extractInlineTags([parent])).toEqual(['nested'])
    })
  })

  describe('hierarchical tags', () => {
    it('extracts hierarchical hashTag inline content nodes', () => {
      const blocks = [textBlock([hashTagItem('movies/oscar')])]
      expect(extractInlineTags(blocks)).toEqual(['movies/oscar'])
    })

    it('extracts hierarchical #tags from text content', () => {
      const blocks = [textBlock([textItem('tagged #movies/oscar and #movies/grammy')])]
      expect(extractInlineTags(blocks)).toEqual(['movies/oscar', 'movies/grammy'])
    })

    it('extracts deeply nested hierarchical tags from text', () => {
      const blocks = [textBlock([textItem('#a/b/c/d')])]
      expect(extractInlineTags(blocks)).toEqual(['a/b/c/d'])
    })

    it('handles mix of flat and hierarchical tags', () => {
      const blocks = [textBlock([hashTagItem('react'), textItem(' and #movies/oscar here')])]
      expect(extractInlineTags(blocks)).toEqual(['react', 'movies/oscar'])
    })

    it('does not capture trailing slash as part of tag', () => {
      const blocks = [textBlock([textItem('#movies/ text')])]
      expect(extractInlineTags(blocks)).toEqual(['movies'])
    })
  })

  describe('empty / edge cases', () => {
    it('returns empty for no blocks', () => {
      expect(extractInlineTags([])).toEqual([])
    })

    it('returns empty for blocks with no content', () => {
      const blocks = [
        { type: 'paragraph', content: [], children: [], id: 'e1', props: {} }
      ] as unknown as Block[]
      expect(extractInlineTags(blocks)).toEqual([])
    })
  })
})
