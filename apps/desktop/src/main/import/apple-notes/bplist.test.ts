import { describe, expect, it } from 'vitest'
import { Uid, isBinaryPlist, parseBinaryPlist, parseKeyedArchiveRoot } from './bplist'
import { buildBinaryPlist } from './locked-note-fixture'

// Produced by Python's plistlib (FMT_BINARY), not by the fixture writer, so the
// reader is checked against an independent encoder.
const PLISTLIB_PLAIN = Buffer.from(
  'YnBsaXN0MDDVAQIDBAUGBwgMDVNiaWdRZFFsUW5RcxMAAAABKgXyAEIAAaMJCgsQAQlReBIAARFwZQBoAOkAbABsAG8IExcZGx0fKCsvMTI0OQAAAAAAAAEBAAAAAAAAAA4AAAAAAAAAAAAAAAAAAABE',
  'base64'
)
const PLISTLIB_ARCHIVE = Buffer.from(
  'YnBsaXN0MDDTAQIDBAUQWSRhcmNoaXZlclgkb2JqZWN0c1QkdG9wXxAPTlNLZXllZEFyY2hpdmVypAYHDA1VJG51bGzSCAkKC1YkY2xhc3NYbWV0YWRhdGGAA4ACQgEC0Q4PWiRjbGFzc25hbWVRWNERElRyb290gAEIDxkiJzk+RElQWVtdYGNucHN4AAAAAAAAAQEAAAAAAAAAEwAAAAAAAAAAAAAAAAAAAHo=',
  'base64'
)

describe('parseBinaryPlist', () => {
  it('round-trips the types a crypto envelope uses', () => {
    const value = {
      n: 70000,
      small: 7,
      s: 'ascii',
      d: Buffer.from([0, 1, 2]),
      l: ['a', 'b'],
      nested: { k: 'v' }
    }
    expect(parseBinaryPlist(buildBinaryPlist(value))).toEqual(value)
  })

  it('rejects non-plist and truncated input without reading out of bounds', () => {
    expect(
      isBinaryPlist(Buffer.from('not a plist at all, but long enough to have a trailer'))
    ).toBe(false)
    expect(() => parseBinaryPlist(buildBinaryPlist({ a: 'b' }).subarray(0, 20))).toThrow(
      'not a binary plist'
    )
  })

  it('resolves the root of a keyed archive and follows UID references', () => {
    const archive = buildBinaryPlist({
      $top: { root: new Uid(1) },
      $objects: ['$null', { name: new Uid(2), raw: Buffer.from([9]) }, 'resolved']
    })
    expect(parseKeyedArchiveRoot(archive)).toEqual({ name: 'resolved', raw: Buffer.from([9]) })
  })

  it('returns null for a plist that is not a keyed archive', () => {
    expect(parseKeyedArchiveRoot(buildBinaryPlist({ a: 'b' }))).toBeNull()
  })

  it('reads what plistlib wrote: unicode, wide ints, bools, data', () => {
    expect(parseBinaryPlist(PLISTLIB_PLAIN)).toEqual({
      s: 'h\u00e9llo',
      n: 70000,
      l: [1, true, 'x'],
      d: Buffer.from([0, 1]),
      big: 5000000000
    })
  })

  it('reads a plistlib keyed archive and its UID references', () => {
    expect(parseKeyedArchiveRoot(PLISTLIB_ARCHIVE)).toEqual({ metadata: Buffer.from([1, 2]) })
  })
})
