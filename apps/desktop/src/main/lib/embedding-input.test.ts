import { describe, it, expect } from 'vitest'
import { buildEmbeddingInput } from './embedding-input'

describe('buildEmbeddingInput', () => {
  it('puts the title first so it survives truncation', () => {
    const out = buildEmbeddingInput({ title: 'Risotto Recipe', content: 'rice and stock' })
    expect(out.startsWith('Risotto Recipe')).toBe(true)
    expect(out).toContain('rice and stock')
  })

  it('omits empty or missing parts', () => {
    expect(buildEmbeddingInput({ content: 'just content' })).toBe('just content')
    expect(buildEmbeddingInput({ title: 'Only Title' })).toBe('Only Title')
    expect(buildEmbeddingInput({ title: '   ', content: 'body' })).toBe('body')
  })

  it('caps the total length', () => {
    const out = buildEmbeddingInput({ title: 'T', content: 'x'.repeat(5000) })
    expect(out.length).toBeLessThanOrEqual(2000)
  })
})
