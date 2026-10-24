import { describe, it, expect } from 'vitest'
import { extractTitleFromBlocks, TITLE_MAX_LENGTH } from './blocknote-title'

const textItem = (text: string) => ({ type: 'text' as const, text, styles: {} })

const linkItem = (href: string, ...texts: string[]) => ({
  type: 'link' as const,
  href,
  content: texts.map((t) => textItem(t))
})

const paragraph = (...content: unknown[]) => ({
  type: 'paragraph',
  props: {},
  content,
  children: []
})

const heading = (...content: unknown[]) => ({
  type: 'heading',
  props: { level: 1 },
  content,
  children: []
})

describe('extractTitleFromBlocks', () => {
  it('returns empty string for empty blocks array', () => {
    expect(extractTitleFromBlocks([])).toBe('')
  })

  it('extracts text from single paragraph block', () => {
    const blocks = [paragraph(textItem('Hello world'))]
    expect(extractTitleFromBlocks(blocks as any)).toBe('Hello world')
  })

  it('concatenates multiple styled text items', () => {
    const blocks = [paragraph(textItem('Hello '), textItem('bold '), textItem('world'))]
    expect(extractTitleFromBlocks(blocks as any)).toBe('Hello bold world')
  })

  it('extracts text from heading block', () => {
    const blocks = [heading(textItem('My Heading'))]
    expect(extractTitleFromBlocks(blocks as any)).toBe('My Heading')
  })

  it('returns empty string when first block is a table', () => {
    const tableBlock = {
      type: 'table',
      props: {},
      content: { type: 'tableContent', rows: [] },
      children: []
    }
    expect(extractTitleFromBlocks([tableBlock] as any)).toBe('')
  })

  it('returns empty string when first block has undefined content', () => {
    const imageBlock = {
      type: 'image',
      props: { url: 'test.png' },
      content: undefined,
      children: []
    }
    expect(extractTitleFromBlocks([imageBlock] as any)).toBe('')
  })

  it('extracts text from link inline content', () => {
    const blocks = [paragraph(linkItem('https://example.com', 'Example Site'))]
    expect(extractTitleFromBlocks(blocks as any)).toBe('Example Site')
  })

  it('truncates title at TITLE_MAX_LENGTH', () => {
    const longText = 'a'.repeat(300)
    const blocks = [paragraph(textItem(longText))]
    const result = extractTitleFromBlocks(blocks as any)
    expect(result.length).toBe(TITLE_MAX_LENGTH)
    expect(result).toBe('a'.repeat(TITLE_MAX_LENGTH))
  })

  it('returns empty string for whitespace-only first block', () => {
    const blocks = [paragraph(textItem('   \n\t  '))]
    expect(extractTitleFromBlocks(blocks as any)).toBe('')
  })

  it('concatenates mixed text and link items in order', () => {
    const blocks = [
      paragraph(textItem('Check '), linkItem('https://example.com', 'this link'), textItem(' now'))
    ]
    expect(extractTitleFromBlocks(blocks as any)).toBe('Check this link now')
  })
})
