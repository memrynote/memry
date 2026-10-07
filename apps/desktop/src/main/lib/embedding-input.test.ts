import { describe, it, expect } from 'vitest'
import {
  buildEmbeddingInput,
  EMBEDDING_TASK_PREFIX,
  MAX_EMBEDDING_INPUT_LENGTH
} from './embedding-input'

describe('buildEmbeddingInput', () => {
  it('prefixes the sentence-similarity task and puts the title first', () => {
    expect(buildEmbeddingInput({ title: 'Risotto Recipe', content: 'rice and stock' })).toBe(
      'task: sentence similarity | query: Risotto Recipe\n\nrice and stock'
    )
  })

  it('omits empty or missing parts', () => {
    expect(buildEmbeddingInput({ content: 'just content' })).toBe(
      `${EMBEDDING_TASK_PREFIX}just content`
    )
    expect(buildEmbeddingInput({ title: 'Only Title' })).toBe(`${EMBEDDING_TASK_PREFIX}Only Title`)
    expect(buildEmbeddingInput({ title: '   ', content: 'body text!' })).toBe(
      `${EMBEDDING_TASK_PREFIX}body text!`
    )
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
    expect(out.startsWith(`${EMBEDDING_TASK_PREFIX}T\n\n`)).toBe(true)
  })
})
