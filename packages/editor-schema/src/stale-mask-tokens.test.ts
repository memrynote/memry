/**
 * The table of stale mask tokens (`@memry/shared/stale-mask-tokens`) covers
 * what the producers make.
 *
 * Each case lets a real mask hide a construct and takes the placeholder it
 * wrote, so a mask whose form changes, or a new one, fails here until the table
 * learns it. `MEMRY` appears in no input, so any in a produced text is a token.
 */

import { describe, expect, it } from 'vitest'
import { maskHardBreaks } from '@memry/shared/hard-breaks'
import { encodeHtmlCommentToken } from '@memry/shared/html-comments'
import { extractInlineColorRuns, maskInlineColorSpans } from '@memry/shared/inline-colors'
import { dropStaleMaskTokens } from '@memry/shared/stale-mask-tokens'
import { escapePrefixedDetailsMarkup } from './blocks/markdown'
import { maskEmptyBlockLines } from './empty-blocks'
import { tokenizeEmphasisRuns } from './inline/emphasis-runs'
import { maskCellCodeSpans } from './inline/cell-code-spans'
import { maskLinkDestinations } from './inline/link-destinations'
import { maskInlineTokens } from './inline/token-masking'

/** A bold run and a code run with a backtick in it, as the writer hands them to the serializer. */
function emphasisTokens(): string {
  const items = [
    { type: 'text', text: 'a', styles: { bold: true } },
    { type: 'text', text: 'b`c', styles: { code: true } }
  ]
  return JSON.stringify(tokenizeEmphasisRuns(items, []))
}

const PRODUCED: Array<[string, () => string]> = [
  ['a hard break', () => maskHardBreaks('a  \nb').markdown],
  ['a comment', () => encodeHtmlCommentToken('<!-- c -->')],
  ['a details tag', () => escapePrefixedDetailsMarkup('<details>')],
  ['a spaced address', () => maskLinkDestinations('[a](u "t")').markdown],
  ['an inline token', () => maskInlineTokens('((mention:a))').markdown],
  [
    'a code span in a cell',
    () => maskCellCodeSpans('| `a b` |\n| - |\n| c |', { pipes: true }).markdown
  ],
  ['an empty block', () => maskEmptyBlockLines('- a\n-\n- b')],
  ['a colour span', () => maskInlineColorSpans('<span style="color:red">x</span>').text],
  [
    'a colour run on write',
    () =>
      JSON.stringify(
        extractInlineColorRuns([
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', styles: { textColor: 'red' } }]
          }
        ]).blocks
      )
  ],
  ['an emphasis run and a code run', emphasisTokens]
]

describe('the stale mask tokens', () => {
  it.each(PRODUCED)('cover %s', (_name, produce) => {
    const produced = produce()
    expect(produced).toContain('MEMRY')
    expect(dropStaleMaskTokens(produced)).not.toContain('MEMRY')
  })
})
