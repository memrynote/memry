import { describe, it, expect } from 'vitest'
import { resolveNoteRelativeUrl } from './resolve-note-relative-url'

const VAULT = '/Users/me/vault'
const NOTE = 'People (1)/Person.md'

describe('resolveNoteRelativeUrl', () => {
  it('resolves a sibling-folder ref against the note directory', () => {
    expect(resolveNoteRelativeUrl('../Images/Media/a.png', NOTE, VAULT)).toBe(
      'memry-file://local/Users/me/vault/Images/Media/a.png'
    )
  })

  it('resolves a same-folder ref', () => {
    expect(resolveNoteRelativeUrl('a.png', NOTE, VAULT)).toBe(
      'memry-file://local/Users/me/vault/People%20(1)/a.png'
    )
  })

  it('resolves a ref from a note at the vault root', () => {
    expect(resolveNoteRelativeUrl('Images/a.png', 'Root.md', VAULT)).toBe(
      'memry-file://local/Users/me/vault/Images/a.png'
    )
  })

  it('decodes percent-encoded refs before resolving', () => {
    expect(resolveNoteRelativeUrl('../Images/my%20photo.png', NOTE, VAULT)).toBe(
      'memry-file://local/Users/me/vault/Images/my%20photo.png'
    )
  })

  it('collapses . and redundant separators', () => {
    expect(resolveNoteRelativeUrl('./sub//a.png', NOTE, VAULT)).toBe(
      'memry-file://local/Users/me/vault/People%20(1)/sub/a.png'
    )
  })

  it.each([
    ['https://example.com/a.png'],
    ['http://example.com/a.png'],
    ['data:image/png;base64,iVBOR'],
    ['blob:abc-123'],
    ['memry-file://local/Users/me/vault/attachments/n1/ab-a.png'],
    ['C:/Users/me/a.png']
  ])('leaves %s untouched', (url) => {
    expect(resolveNoteRelativeUrl(url, NOTE, VAULT)).toBe(url)
  })

  it('leaves vault-absolute paths untouched', () => {
    expect(resolveNoteRelativeUrl('/Images/a.png', NOTE, VAULT)).toBe('/Images/a.png')
  })

  it('leaves the url untouched when it would escape the vault', () => {
    expect(resolveNoteRelativeUrl('../../../etc/passwd', NOTE, VAULT)).toBe('../../../etc/passwd')
  })

  it('leaves the url untouched without a note path or vault path', () => {
    expect(resolveNoteRelativeUrl('a.png', undefined, VAULT)).toBe('a.png')
    expect(resolveNoteRelativeUrl('a.png', NOTE, null)).toBe('a.png')
  })

  it('returns empty input as-is', () => {
    expect(resolveNoteRelativeUrl('', NOTE, VAULT)).toBe('')
  })

  // A Capacities export copied straight into a vault: emoji + spaces + parens in
  // the note path, media in a sibling folder.
  it('handles a Capacities export laid out in the vault', () => {
    expect(
      resolveNoteRelativeUrl(
        '../Images/Media/01KX65VSYZ9NBBNP9PG7ARJKD2.png',
        'People (1)/🙋♂️ How to Use This People Object.md',
        '/Users/me/vault/cap'
      )
    ).toBe('memry-file://local/Users/me/vault/cap/Images/Media/01KX65VSYZ9NBBNP9PG7ARJKD2.png')
  })
})
