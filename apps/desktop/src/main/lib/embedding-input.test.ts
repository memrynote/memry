import { describe, it, expect } from 'vitest'
import {
  buildEmbeddingInput,
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
