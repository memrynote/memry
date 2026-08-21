import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  bumpAttachmentRevision,
  getAttachmentRevision,
  resetAttachmentRevisions,
  subscribeToAttachmentRevisions,
  withAttachmentRevision
} from './attachment-revision'

describe('attachment revision', () => {
  beforeEach(() => {
    resetAttachmentRevisions()
    // Assigned, not deleted: the shared renderer setup defines `window.api` as a
    // non-configurable property, so `delete` throws.
    // @ts-expect-error - standing in for an API surface that is absent here
    window.api = undefined
  })

  it('leaves a URL alone until an attachment for that note lands', () => {
    // Nothing arrived, so the block must render byte-for-byte what it always
    // did — the suffix is a recovery mechanism, not a default.
    const url = 'memry-file://local/vault/attachments/note-a/x.pdf'
    expect(withAttachmentRevision(url, getAttachmentRevision('note-a'))).toBe(url)
  })

  it('changes the URL once the note gets an attachment, so the block asks again', () => {
    bumpAttachmentRevision('note-a')

    const url = 'memry-file://local/vault/attachments/note-a/x.pdf'
    expect(withAttachmentRevision(url, getAttachmentRevision('note-a'))).toBe(`${url}?v=1`)
  })

  it('keeps a second arrival distinguishable from the first', () => {
    bumpAttachmentRevision('note-a')
    bumpAttachmentRevision('note-a')

    expect(getAttachmentRevision('note-a')).toBe(2)
    expect(withAttachmentRevision('memry-file://local/a.pdf', 2)).toBe(
      'memry-file://local/a.pdf?v=2'
    )
  })

  it('appends to a URL that already carries a query', () => {
    expect(withAttachmentRevision('memry-file://local/a.pdf?page=2', 3)).toBe(
      'memry-file://local/a.pdf?page=2&v=3'
    )
  })

  it('does not touch an unresolved relative ref', () => {
    // It has no scheme yet, so it has not been resolved to a file at all —
    // versioning it would only produce a ref that resolves to nothing.
    expect(withAttachmentRevision('../attachments/note-a/x.pdf', 4)).toBe(
      '../attachments/note-a/x.pdf'
    )
  })

  it('revisions one note without disturbing another', () => {
    bumpAttachmentRevision('note-a')

    expect(getAttachmentRevision('note-a')).toBe(1)
    expect(getAttachmentRevision('note-b')).toBe(0)
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToAttachmentRevisions(listener)

    bumpAttachmentRevision('note-a')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    bumpAttachmentRevision('note-a')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('binds to main once, however many blocks subscribe', () => {
    const onAttachmentMaterialized = vi.fn()
    // @ts-expect-error - minimal stand-in for the preload API surface
    window.api = { onAttachmentMaterialized }

    subscribeToAttachmentRevisions(vi.fn())
    subscribeToAttachmentRevisions(vi.fn())

    expect(onAttachmentMaterialized).toHaveBeenCalledTimes(1)
  })

  it('bumps the revision of the note main says an attachment landed for', () => {
    let handler: ((event: { noteId: string }) => void) | undefined
    // @ts-expect-error - minimal stand-in for the preload API surface
    window.api = {
      onAttachmentMaterialized: (cb: (event: { noteId: string }) => void) => {
        handler = cb
        return () => {}
      }
    }

    subscribeToAttachmentRevisions(vi.fn())
    handler?.({ noteId: 'note-a' })

    expect(getAttachmentRevision('note-a')).toBe(1)
  })
})
