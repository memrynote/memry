import { describe, it, expect } from 'vitest'
import { resolveRefs } from './resolve-refs.ts'
import type { BlockIndex } from './types.ts'

function makeIndex(): BlockIndex {
  return new Map([
    ['abc', { pageTitle: 'Target Page', text: 'the referenced text' }],
    ['empty', { pageTitle: 'Empty Block Page', text: '' }],
    ['markup', { pageTitle: 'Markup Page', text: '{{[[TODO]]}} __scrub__ me' }]
  ])
}

describe('resolveRefs (fallback mode)', () => {
  it('resolves ((uid)) to a wikilink + quoted block text', () => {
    expect(resolveRefs('see ((abc)) now', makeIndex())).toBe(
      'see [[Target Page]]: "the referenced text" now'
    )
  })

  it('resolves {{embed:((uid))}} the same way as a plain ref', () => {
    expect(resolveRefs('{{embed:((abc))}}', makeIndex())).toBe(
      '[[Target Page]]: "the referenced text"'
    )
  })

  it('omits the quote when the referenced block is empty', () => {
    expect(resolveRefs('((empty))', makeIndex())).toBe('[[Empty Block Page]]')
  })

  it('scrubs markup in the quoted referenced text', () => {
    expect(resolveRefs('((markup))', makeIndex())).toBe('[[Markup Page]]: "[ ] *scrub* me"')
  })

  it('leaves unknown uids as plain text (parens stripped)', () => {
    expect(resolveRefs('ref ((missing)) here', makeIndex())).toBe('ref missing here')
  })

  it('emits no ^uid anchors', () => {
    expect(resolveRefs('((abc))', makeIndex())).not.toContain('^')
  })
})
