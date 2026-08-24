/**
 * The ref arithmetic a note move depends on: every relative ref in the body has
 * to keep naming the same file after the note lands somewhere else, and a move
 * that changes nothing has to change no bytes.
 *
 * @module blocks/rewrite-note-refs.test
 */

import { describe, it, expect } from 'vitest'
import { rewriteNoteRefsForMove } from './rewrite-note-refs.ts'

describe('rewriteNoteRefsForMove', () => {
  it('returns null for a move that keeps the note in the same folder', () => {
    const body = '![photo](../attachments/n1/photo.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/Foo-1.md')).toBeNull()
  })

  it('returns null when the recomputed ref is identical to the one on disk', () => {
    // Same depth, different prefix: `../../attachments/...` is correct from both.
    const body = '![photo](../../attachments/n1/photo.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/a/Foo.md', 'notes/b/Foo.md')).toBeNull()
  })

  it('adds one `../` per folder the note moved down into', () => {
    const body = '![photo](../attachments/n1/photo.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/2026/Foo.md')).toBe(
      '![photo](../../../attachments/n1/photo.png)\n'
    )
  })

  it('drops the `../` the note no longer needs when it moves up', () => {
    const body = '![photo](../../../attachments/n1/photo.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/archive/2026/Foo.md', 'notes/Foo.md')).toBe(
      '![photo](../attachments/n1/photo.png)\n'
    )
  })

  it('writes a bare path when the note moves to the vault root', () => {
    const body = '![photo](../attachments/n1/photo.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'Foo.md')).toBe(
      '![photo](attachments/n1/photo.png)\n'
    )
  })

  it('re-points a ref at another vault file, not just at an attachment', () => {
    const body = '![photo](images/photo.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/Foo.md')).toBe(
      '![photo](../images/photo.png)\n'
    )
  })

  it('rewrites only the url member of a file marker, byte for byte otherwise', () => {
    const marker =
      '<!-- file:{"url":"../attachments/n1/plan.pdf","name":"plan.pdf","size":1024,' +
      '"mimeType":"application/pdf","width":720,"height":300,"align":"center"} -->'

    const result = rewriteNoteRefsForMove(marker, 'notes/Foo.md', 'notes/archive/2026/Foo.md')

    expect(result).toBe(
      '<!-- file:{"url":"../../../attachments/n1/plan.pdf","name":"plan.pdf","size":1024,' +
        '"mimeType":"application/pdf","width":720,"height":300,"align":"center"} -->'
    )
  })

  it('keeps a file marker escape intact when the filename ends a comment', () => {
    const marker =
      '<!-- file:{"url":"../attachments/n1/a--\\u003eb.pdf","name":"a--\\u003eb.pdf",' +
      '"size":1,"mimeType":"application/pdf"} -->'

    expect(rewriteNoteRefsForMove(marker, 'notes/Foo.md', 'notes/archive/Foo.md')).toBe(
      '<!-- file:{"url":"../../attachments/n1/a--\\u003eb.pdf","name":"a--\\u003eb.pdf",' +
        '"size":1,"mimeType":"application/pdf"} -->'
    )
  })

  it('leaves an absolute memry-file url alone', () => {
    const body =
      '![photo](memry-file://local/Users/k/vault/attachments/n1/photo.png)\n' +
      '<!-- file:{"url":"memry-file://local/Users/k/vault/attachments/n1/p.pdf","name":"p.pdf",' +
      '"size":1,"mimeType":"application/pdf"} -->\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/Foo.md')).toBeNull()
  })

  it('leaves remote and data urls alone', () => {
    const body =
      '![remote](https://example.com/photo.png)\n' +
      '![inline](data:image/png;base64,AAAA)\n' +
      '[link](https://example.com/page)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/Foo.md')).toBeNull()
  })

  it('leaves wiki-links alone — they resolve by title, not by path', () => {
    const body = '[[Other Note]]\n![[photo.png]]\n[[Folder/Other|alias]]\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/2026/Foo.md')).toBeNull()
  })

  it('keeps a percent-encoded ref encoded after the move', () => {
    const body = '![photo](../attachments/n1/my%20photo%281%29.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/Foo.md')).toBe(
      '![photo](../../attachments/n1/my%20photo%281%29.png)\n'
    )
  })

  it('leaves a percent-encoded ref byte-identical when the path math is a no-op', () => {
    // `%C3%A9` re-encodes to a bare `é`, so a naive decode/encode round trip would
    // rewrite this note on a move that changes nothing about where the ref points.
    const body = '![photo](../../attachments/n1/caf%C3%A9.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/a/Foo.md', 'notes/b/Foo.md')).toBeNull()
  })

  it('leaves a ref that climbs above the vault root alone', () => {
    const body = '![escape](../../outside.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/2026/Foo.md')).toBeNull()
  })

  it('leaves a root-anchored ref alone', () => {
    const body = '![abs](/attachments/n1/photo.png)\n![unc](\\\\server\\share\\photo.png)\n'

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/Foo.md')).toBeNull()
  })

  it('rewrites every ref in a body and leaves the rest of the markdown untouched', () => {
    const body = [
      '---',
      'title: Foo',
      '---',
      '',
      '# Heading',
      '',
      '![one](../attachments/n1/one.png)',
      '',
      'Some prose with a [[Wiki Link]] and a [link](https://example.com).',
      '',
      '<!-- file:{"url":"../attachments/n1/two.pdf","name":"two.pdf","size":2,' +
        '"mimeType":"application/pdf"} -->',
      ''
    ].join('\n')

    expect(rewriteNoteRefsForMove(body, 'notes/Foo.md', 'notes/archive/Foo.md')).toBe(
      [
        '---',
        'title: Foo',
        '---',
        '',
        '# Heading',
        '',
        '![one](../../attachments/n1/one.png)',
        '',
        'Some prose with a [[Wiki Link]] and a [link](https://example.com).',
        '',
        '<!-- file:{"url":"../../attachments/n1/two.pdf","name":"two.pdf","size":2,' +
          '"mimeType":"application/pdf"} -->',
        ''
      ].join('\n')
    )
  })

  it('returns null for an empty body', () => {
    expect(rewriteNoteRefsForMove('', 'notes/Foo.md', 'notes/archive/Foo.md')).toBeNull()
  })
})
