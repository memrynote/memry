import { describe, expect, it } from 'vitest'
import { FIND_REQUEST_KEY, readFindRequest } from './find-request'

describe('readFindRequest', () => {
  it('reads a well-formed request', () => {
    expect(readFindRequest({ [FIND_REQUEST_KEY]: { query: 'kedi', index: 2 } })).toEqual({
      query: 'kedi',
      index: 2
    })
  })

  it.each([
    undefined,
    {},
    { [FIND_REQUEST_KEY]: null },
    { [FIND_REQUEST_KEY]: 'kedi' },
    { [FIND_REQUEST_KEY]: { query: '', index: 0 } },
    { [FIND_REQUEST_KEY]: { query: 'kedi', index: -1 } },
    { [FIND_REQUEST_KEY]: { query: 'kedi', index: 1.5 } }
  ])('ignores %j', (viewState) => {
    expect(readFindRequest(viewState)).toBeNull()
  })
})
