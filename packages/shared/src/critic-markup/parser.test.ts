import { describe, expect, it } from 'vitest'
import { parseCriticMarkup, serializeCriticMarkup } from './parser'

describe('parseCriticMarkup', () => {
  it('parses additions, deletions, substitutions, and highlight comments into clean text', () => {
    const parsed = parseCriticMarkup(
      'Alpha {++new++} {--old--} {~~wrong~>right~~} {==quote==}{>>id=c1;type=comment | note<<}.'
    )

    expect(parsed.plainText).toBe('Alpha new old right quote.')
    expect(parsed.marks).toEqual([
      expect.objectContaining({
        kind: 'addition',
        visibleText: 'new',
        start: 6,
        end: 9
      }),
      expect.objectContaining({
        kind: 'deletion',
        visibleText: 'old',
        start: 10,
        end: 13
      }),
      expect.objectContaining({
        kind: 'substitution',
        originalText: 'wrong',
        visibleText: 'right',
        start: 14,
        end: 19
      }),
      expect.objectContaining({
        id: 'c1',
        kind: 'comment',
        visibleText: 'quote',
        body: 'note',
        metadata: 'id=c1;type=comment',
        start: 20,
        end: 25
      })
    ])
  })

  it('roundtrips parsed marks without exposing raw syntax in the plain text', () => {
    const source = 'A {==selected text==}{>>id=comment-1 | body<<} and {++new text++}'
    const parsed = parseCriticMarkup(source)

    expect(parsed.plainText).toBe('A selected text and new text')
    expect(serializeCriticMarkup(parsed.plainText, parsed.marks)).toBe(source)
  })

  it('roundtrips comment mentions and attachments through metadata', () => {
    const plainText = 'A selected text'
    const serialized = serializeCriticMarkup(plainText, [
      {
        id: 'comment-1',
        kind: 'comment',
        visibleText: 'selected text',
        body: 'Check @Planning note and the file.',
        mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
        attachments: [
          {
            id: 'attachments/note-1/spec.pdf',
            name: 'spec.pdf',
            path: 'attachments/note-1/spec.pdf',
            size: 1234,
            mimeType: 'application/pdf',
            type: 'file'
          }
        ],
        metadata: 'id=comment-1;type=comment',
        start: 2,
        end: 15
      }
    ])

    const parsed = parseCriticMarkup(serialized)

    expect(serialized).toContain('mentions=')
    expect(serialized).toContain('attachments=')
    expect(parsed.marks[0]).toMatchObject({
      id: 'comment-1',
      kind: 'comment',
      body: 'Check @Planning note and the file.',
      mentions: [{ kind: 'note', refId: 'note-1', label: 'Planning note' }],
      attachments: [
        {
          id: 'attachments/note-1/spec.pdf',
          name: 'spec.pdf',
          path: 'attachments/note-1/spec.pdf',
          size: 1234,
          mimeType: 'application/pdf',
          type: 'file'
        }
      ]
    })
    expect(serializeCriticMarkup(parsed.plainText, parsed.marks)).toBe(serialized)
  })

  it('roundtrips comment createdAt through metadata', () => {
    const source = 'A {==quote==}{>>id=c1;type=comment;createdAt=1748254022000 | body<<}'
    const parsed = parseCriticMarkup(source)

    expect(parsed.marks[0]).toMatchObject({
      id: 'c1',
      kind: 'comment',
      body: 'body',
      createdAt: 1748254022000
    })
    expect(serializeCriticMarkup(parsed.plainText, parsed.marks)).toBe(source)
  })

  it('derives createdAt from the comment mark id when metadata has none', () => {
    const timestamp = Date.UTC(2026, 4, 26, 12, 3, 42)
    const id = `critic-comment-${timestamp.toString(36)}-abc123`
    const parsed = parseCriticMarkup(`A {==quote==}{>>id=${id};type=comment | body<<}`)

    expect(parsed.marks[0].createdAt).toBe(timestamp)
  })

  it('prefers metadata createdAt over the id-derived timestamp', () => {
    const id = `critic-comment-${Date.UTC(2025, 0, 1).toString(36)}-abc123`
    const parsed = parseCriticMarkup(
      `A {==quote==}{>>id=${id};type=comment;createdAt=1748254022000 | body<<}`
    )

    expect(parsed.marks[0].createdAt).toBe(1748254022000)
  })

  it('does not derive createdAt from non-timestamp comment ids', () => {
    const parsed = parseCriticMarkup(
      'A {==quote==}{>>id=critic-comment-12-abc;type=comment | body<<}'
    )

    expect(parsed.marks[0].createdAt).toBeUndefined()
  })

  it('ignores invalid createdAt metadata values', () => {
    const parsed = parseCriticMarkup(
      'A {==quote==}{>>id=c1;type=comment;createdAt=not-a-number | body<<}'
    )

    expect(parsed.marks[0].createdAt).toBeUndefined()
  })

  it('ignores malformed structured comment metadata while preserving legacy comments', () => {
    const parsed = parseCriticMarkup(
      'A {==quote==}{>>id=c1;type=comment;mentions=%7Bbad;attachments=%5B%7B%7D%5D | body<<}'
    )

    expect(parsed.marks[0]).toMatchObject({
      id: 'c1',
      kind: 'comment',
      visibleText: 'quote',
      body: 'body',
      metadata: 'id=c1;type=comment;mentions=%7Bbad;attachments=%5B%7B%7D%5D'
    })
    expect(parsed.marks[0].mentions).toBeUndefined()
    expect(parsed.marks[0].attachments).toBeUndefined()
  })

  it('does not relocate stale one-letter suggestion ranges to the first match', () => {
    const plainText = 'Why I keep at it Wikipedia flight'

    expect(
      serializeCriticMarkup(plainText, [
        {
          id: 'stale-deletion',
          kind: 'deletion',
          visibleText: 'i',
          originalText: 'i',
          start: 0,
          end: 1
        }
      ])
    ).toBe(plainText)

    expect(
      serializeCriticMarkup(plainText, [
        {
          id: 'stale-addition',
          kind: 'addition',
          visibleText: 'p',
          start: 0,
          end: 1
        }
      ])
    ).toBe(plainText)
  })
})
