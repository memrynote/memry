import { describe, expect, it } from 'vitest'
import { markdownToBlocks } from './blocknote-converter'

/**
 * Pasted or synced markdown is user input, and the seed parse reads it on the
 * main process. Each input below made BlockNote's inline parser take seconds
 * through the same entry the seed uses (`markdownToBlocks`, which masks, parses
 * and repairs), so a long paragraph of it hung the note.
 */
const LIMIT_MS = 250

const cases: Array<[string, string]> = [
  ['a run of unclosed italics', '*a '.repeat(5000)],
  ['a run of unclosed link texts', '[a'.repeat(8000)],
  ['a run of unclosed link addresses', '[a](b'.repeat(5000)]
]

describe('adversarial markdown through the seed parse', () => {
  it.each(cases)('%s parses in linear time', async (_name, markdown) => {
    await markdownToBlocks('warm the editor up')
    const start = performance.now()
    const blocks = await markdownToBlocks(markdown)
    const elapsed = performance.now() - start
    expect(blocks).not.toBeNull()
    expect(elapsed).toBeLessThan(LIMIT_MS)
  })
})
