import { describe, it, expect } from 'vitest'
import { noteRelativeRef, resolveNoteRelativeUrl } from './resolve-note-relative-url'

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

  // `toMemryFileUrl` rewrites `\` to `/`, so a backslash ref that slipped past
  // the guard as one opaque segment would only become a traversal afterwards.
  it('treats backslashes as separators when resolving', () => {
    expect(resolveNoteRelativeUrl('..\\Images\\Media\\a.png', NOTE, VAULT)).toBe(
      'memry-file://local/Users/me/vault/Images/Media/a.png'
    )
    expect(resolveNoteRelativeUrl('sub\\a.png', NOTE, VAULT)).toBe(
      'memry-file://local/Users/me/vault/People%20(1)/sub/a.png'
    )
  })

  it('leaves a backslash ref untouched when it would escape the vault', () => {
    expect(resolveNoteRelativeUrl('..\\..\\..\\etc\\passwd', NOTE, VAULT)).toBe(
      '..\\..\\..\\etc\\passwd'
    )
  })

  it.each([['\\Images\\a.png'], ['\\\\server\\share\\a.png']])(
    'leaves the leading-backslash ref %s untouched',
    (url) => {
      expect(resolveNoteRelativeUrl(url, NOTE, VAULT)).toBe(url)
    }
  )

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

describe('noteRelativeRef', () => {
  // Mirrors `noteRelativeRef` in apps/desktop/src/main/lib/paths.ts, which
  // covers the same cases — the renderer cannot import from main.
  it('climbs out of the note folder to reach the attachments tree', () => {
    expect(noteRelativeRef('notes/Meeting.md', 'attachments/note123/abc-plan.pdf')).toBe(
      '../attachments/note123/abc-plan.pdf'
    )
  })

  it('needs no climb for a note at the vault root', () => {
    expect(noteRelativeRef('Meeting.md', 'attachments/n/x.png')).toBe('attachments/n/x.png')
  })

  it('climbs once per nested folder', () => {
    expect(noteRelativeRef('notes/work/q3/Review.md', 'attachments/n/x.png')).toBe(
      '../../../attachments/n/x.png'
    )
  })

  it('keeps the shared prefix instead of climbing past it', () => {
    expect(noteRelativeRef('notes/Trip.md', 'notes/images/photo.png')).toBe('images/photo.png')
  })

  it('emits forward slashes for a Windows-shaped input', () => {
    expect(noteRelativeRef('notes\\work\\Trip.md', 'attachments\\n\\x.png')).toBe(
      '../../attachments/n/x.png'
    )
  })

  // The round trip that matters: what this writes, the render-time resolver
  // has to be able to turn back into a file inside the vault.
  it('round-trips through resolveNoteRelativeUrl', () => {
    const ref = noteRelativeRef('notes/work/Review.md', 'attachments/n1/abc-plan.pdf')

    expect(resolveNoteRelativeUrl(ref, 'notes/work/Review.md', '/Users/me/vault')).toBe(
      'memry-file://local/Users/me/vault/attachments/n1/abc-plan.pdf'
    )
  })
})
