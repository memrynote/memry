import { describe, expect, it } from 'vitest'

import { decidePageAdvance } from './pull-coordinator'

describe('decidePageAdvance', () => {
  it('does not advance the cursor when the page failed to parse', () => {
    expect(
      decidePageAdvance({ applied: 0, conflicts: 0, allCryptoFailed: false, pageFailed: true })
    ).toEqual({ advanceCursor: false, stop: true })
  })

  it('advances and continues on a normal page', () => {
    expect(
      decidePageAdvance({ applied: 5, conflicts: 0, allCryptoFailed: false, pageFailed: false })
    ).toEqual({ advanceCursor: true, stop: false })
  })

  it('advances but stops when every item failed to decrypt', () => {
    expect(
      decidePageAdvance({ applied: 0, conflicts: 0, allCryptoFailed: true, pageFailed: false })
    ).toEqual({ advanceCursor: true, stop: true })
  })

  it('advances on an applied-nothing page that did not fail', () => {
    expect(
      decidePageAdvance({ applied: 0, conflicts: 0, allCryptoFailed: false, pageFailed: false })
    ).toEqual({ advanceCursor: true, stop: false })
  })
})
