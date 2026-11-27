import { describe, expect, it } from 'vitest'
import { maskHardBreaks } from './hard-breaks'
import { maskInlineColorSpans } from './inline-colors'
import { stripMarkdownComments } from './markdown-code'

/**
 * Pasted or synced markdown is user input, and these masks run on the
 * renderer's thread. Each input below made a backtracking regex take seconds;
 * every mask must stay linear in its input.
 */
const LIMIT_MS = 100

const cases: Array<[string, () => unknown]> = [
  // Each shorter split of the run is compared against the rest of it, then fails at the text.
  [
    'a long run of backticks beside a color span',
    () => maskInlineColorSpans(`x ${'`'.repeat(150_000)}${'a'.repeat(150_000)}</span>`)
  ],
  ['a delimiter row under a table row', () => maskHardBreaks(`| a |\n|-${'\t'.repeat(50_000)}x`)],
  // Each `>` could take the space after it or leave it to the next marker.
  [
    'quote and list markers before no comment',
    () => stripMarkdownComments(`<!-- c -->\n>${' -  >'.repeat(24)}\0`)
  ]
]

describe('adversarial markdown input', () => {
  it.each(cases)('%s runs in linear time', (_name, run) => {
    const start = performance.now()
    run()
    expect(performance.now() - start).toBeLessThan(LIMIT_MS)
  })
})
