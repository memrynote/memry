import { describe, it, expect } from 'vitest'
import {
  buildEmbeddingChunks,
  buildEmbeddingInput,
  buildInterleavedInput,
  MAX_INTERLEAVED_TEXT_LENGTH,
  MAX_EMBEDDING_CHUNKS,
  buildQueryEmbeddingInput,
  MAX_EMBEDDING_INPUT_LENGTH
} from './embedding-input'

describe('buildEmbeddingInput', () => {
  it('uses the document prefix with the title first', () => {
    expect(buildEmbeddingInput({ title: 'Risotto Recipe', content: 'rice and stock' })).toBe(
      'title: Risotto Recipe | text: rice and stock'
    )
  })

  it('writes `title: none` for an untitled note', () => {
    expect(buildEmbeddingInput({ content: 'just content' })).toBe(
      'title: none | text: just content'
    )
    expect(buildEmbeddingInput({ title: '   ', content: 'body text!' })).toBe(
      'title: none | text: body text!'
    )
  })

  it('embeds a title-only note', () => {
    expect(buildEmbeddingInput({ title: 'Only Title' })).toBe('title: Only Title | text: ')
  })

  // Callers skip inputs under their own minimum; the prefix alone must not
  // carry a two-letter note past it.
  it('returns nothing for text too short to embed', () => {
    expect(buildEmbeddingInput({ title: 'Hi', content: null })).toBe('')
    expect(buildEmbeddingInput({})).toBe('')
  })

  it('caps the total length, prefix included', () => {
    const out = buildEmbeddingInput({ title: 'T', content: 'x'.repeat(5000) })
    expect(out.length).toBe(MAX_EMBEDDING_INPUT_LENGTH)
    expect(out.startsWith('title: T | text: ')).toBe(true)
  })
})

describe('buildQueryEmbeddingInput', () => {
  it('uses the search-result query prefix', () => {
    expect(buildQueryEmbeddingInput('  cat ')).toBe('task: search result | query: cat')
  })

  it('returns nothing for an empty query', () => {
    expect(buildQueryEmbeddingInput('   ')).toBe('')
  })
})

describe('buildEmbeddingChunks', () => {
  it('matches buildEmbeddingInput for a note that fits one window', () => {
    const parts = { title: 'Risotto', content: 'rice and stock' }
    expect(buildEmbeddingChunks(parts)).toEqual([buildEmbeddingInput(parts)])
  })

  it('returns nothing for text too short to embed', () => {
    expect(buildEmbeddingChunks({ title: 'Hi' })).toEqual([])
  })

  it('splits a long note into windows that each fit and carry the title, losing no text', () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i}. ${'word '.repeat(150)}`
    )
    const windows = buildEmbeddingChunks({ title: 'Long', content: paragraphs.join('\n\n') })
    expect(windows.length).toBeGreaterThan(1)
    for (const window of windows) {
      expect(window.length).toBeLessThanOrEqual(MAX_EMBEDDING_INPUT_LENGTH)
      expect(window.startsWith('title: Long | text: ')).toBe(true)
    }
    const body = windows.map((w) => w.slice('title: Long | text: '.length)).join(' ')
    expect(body).toContain('Paragraph 11.')
    // Breaks fall on paragraph boundaries here, so no paragraph is split.
    expect(windows[0].endsWith('word')).toBe(true)
  })

  it('cuts a note at the window cap', () => {
    const windows = buildEmbeddingChunks({ title: 'T', content: 'x'.repeat(500_000) })
    expect(windows).toHaveLength(MAX_EMBEDDING_CHUNKS)
  })
})

describe('buildInterleavedInput', () => {
  it('puts the text before the image placeholder under the document prefix', () => {
    expect(buildInterleavedInput('  Invoice total 42 EUR  ')).toBe(
      'title: none | text: Invoice total 42 EUR <|image|>'
    )
  })

  it('cuts long text so the page keeps its share of the window', () => {
    const input = buildInterleavedInput('x'.repeat(10_000)) ?? ''
    expect(input).toBe(`title: none | text: ${'x'.repeat(MAX_INTERLEAVED_TEXT_LENGTH)} <|image|>`)
  })

  it('is null when there is too little text, so the image is embedded alone', () => {
    expect(buildInterleavedInput('  hi ')).toBeNull()
    expect(buildInterleavedInput('')).toBeNull()
    expect(buildInterleavedInput(null)).toBeNull()
  })
})
