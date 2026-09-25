import { describe, expect, it, vi, type Mock } from 'vitest'
import * as Y from 'yjs'
import { landNoteBody, type NoteBodyLandingDeps } from './note-body-apply'

/**
 * #2297: how a remote body from the change feed reaches the local CRDT store.
 * A note this device knows, with a persisted doc, is opened and merged live, so
 * the editor and the markdown write-back see it, and the landing resolves once
 * the store holds every update. Nothing else is stored.
 */

function textUpdates(): { base: Uint8Array; delta: Uint8Array } {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, 'a')
  const base = Y.encodeStateAsUpdate(doc)
  const vector = Y.encodeStateVector(doc)
  doc.getText('t').insert(1, 'b')
  return { base, delta: Y.encodeStateAsUpdate(doc, vector) }
}

/** `persisted` is what the store holds per note; `open` loads it like `doOpen`. */
function fakeProvider(
  openDocs: Map<string, Y.Doc> = new Map(),
  persisted: Map<string, Uint8Array> = new Map()
) {
  const calls: string[] = []
  const provider = {
    calls,
    getDoc: vi.fn((noteId: string) => openDocs.get(noteId)),
    getStateVector: vi.fn((noteId: string) => {
      const doc = openDocs.get(noteId)
      return doc ? Y.encodeStateVector(doc) : null
    }),
    open: vi.fn(async (noteId: string, _windowId?: number, options?: { skipSeed?: boolean }) => {
      calls.push(`open:${noteId}:${options?.skipSeed === true}`)
      let doc = openDocs.get(noteId)
      if (!doc) {
        doc = new Y.Doc()
        const state = persisted.get(noteId)
        if (state) Y.applyUpdate(doc, state)
        openDocs.set(noteId, doc)
      }
      return doc
    }),
    mergeRemoteUpdate: vi.fn(async (noteId: string, update: Uint8Array) => {
      calls.push(`merge:${noteId}:${update.byteLength}`)
      Y.applyUpdate(openDocs.get(noteId)!, update)
      return true
    }),
    closeIfInactive: vi.fn(async (noteId: string) => {
      calls.push(`close:${noteId}`)
      openDocs.delete(noteId)
      return true
    })
  }
  return provider
}

function deps(
  provider: ReturnType<typeof fakeProvider>,
  known: string[] | ((noteId: string) => boolean) = []
): NoteBodyLandingDeps & { onMissingBase: Mock<(noteId: string) => void> } {
  return {
    provider: provider as unknown as NoteBodyLandingDeps['provider'],
    isKnownNote: typeof known === 'function' ? known : (noteId) => known.includes(noteId),
    onMissingBase: vi.fn<(noteId: string) => void>()
  }
}

describe('landNoteBody (#2297)', () => {
  it('#given a known note with a persisted doc #then it opens without a seed, merges durably and closes', async () => {
    const { base, delta } = textUpdates()
    const provider = fakeProvider(new Map(), new Map([['note-1', base]]))

    await expect(landNoteBody(deps(provider, ['note-1']), 'note-1', [delta])).resolves.toBe(true)

    expect(provider.calls).toEqual([
      'open:note-1:true',
      `merge:note-1:${delta.byteLength}`,
      'close:note-1'
    ])
  })

  it('#given a doc an editor holds open #then it merges into that doc and leaves it open', async () => {
    const { base, delta } = textUpdates()
    const editorDoc = new Y.Doc()
    Y.applyUpdate(editorDoc, base)
    const provider = fakeProvider(new Map([['note-1', editorDoc]]))

    await landNoteBody(deps(provider, ['note-1']), 'note-1', [delta])

    expect(provider.closeIfInactive).not.toHaveBeenCalled()
    expect(editorDoc.getText('t').toString()).toBe('ab')
  })

  // #2299 review round 2 (B-M4): a body buffered by a running compaction is
  // in neither the doc nor the store, and the compaction may drop it.
  it('#given the doc is compacting #then the body is owed, never reported landed', async () => {
    const { base, delta } = textUpdates()
    const provider = fakeProvider(new Map(), new Map([['note-1', base]]))
    provider.mergeRemoteUpdate.mockResolvedValueOnce(false)
    const landingDeps = deps(provider, ['note-1'])

    await expect(landNoteBody(landingDeps, 'note-1', [delta])).resolves.toBe(false)

    expect(landingDeps.onMissingBase).toHaveBeenCalledExactlyOnceWith('note-1')
  })

  // #2297 review: a rowless id is dropped, neither stored nor owed. Stored bytes
  // would make the whole-body merge the record's page runs a no-op, so the
  // write-back never writes the file (C3/C4); owing it would let the sweep's
  // merge write a deleted note back.
  it('#given an id this device has no note or journal for #then nothing is stored, opened or owed', async () => {
    const provider = fakeProvider()
    const { base } = textUpdates()
    const landingDeps = deps(provider)

    await expect(landNoteBody(landingDeps, 'note-gone', [base])).resolves.toBe(false)

    expect(provider.calls).toEqual([])
    expect(landingDeps.onMissingBase).not.toHaveBeenCalled()
  })

  // #2297 review (A-L4): a delete can land while `open` awaits the store.
  it('#given the note is deleted while its doc opens #then nothing is merged live', async () => {
    const { base, delta } = textUpdates()
    const provider = fakeProvider(new Map(), new Map([['note-1', base]]))
    let rowExists = true
    provider.open.mockImplementationOnce(async () => {
      rowExists = false
      const doc = new Y.Doc()
      Y.applyUpdate(doc, base)
      return doc
    })

    await landNoteBody(
      deps(provider, () => rowExists),
      'note-1',
      [delta]
    )

    expect(provider.mergeRemoteUpdate).not.toHaveBeenCalled()
  })

  // #2297 review (A-L5, B-9): a known note with no persisted doc is never given
  // a live delta, which could write a partial body over its file; it is owed
  // its whole body, whose live merge writes the file back.
  it('#given a known note with no persisted doc #then it is owed its whole body and nothing is stored', async () => {
    const provider = fakeProvider()
    const { delta } = textUpdates()
    const landingDeps = deps(provider, ['note-1'])

    await expect(landNoteBody(landingDeps, 'note-1', [delta])).resolves.toBe(false)

    expect(provider.mergeRemoteUpdate).not.toHaveBeenCalled()
    expect(landingDeps.onMissingBase).toHaveBeenCalledWith('note-1')
    expect(provider.closeIfInactive).toHaveBeenCalledWith('note-1')
  })

  it('#given a delta whose base the persisted doc lacks #then the note is owed a whole-body pull', async () => {
    const other = new Y.Doc()
    other.getText('x').insert(0, 'unrelated')
    const provider = fakeProvider(new Map(), new Map([['note-1', Y.encodeStateAsUpdate(other)]]))
    const { delta } = textUpdates()
    const landingDeps = deps(provider, ['note-1'])

    await expect(landNoteBody(landingDeps, 'note-1', [delta])).resolves.toBe(false)

    expect(landingDeps.onMissingBase).toHaveBeenCalledWith('note-1')
    expect(provider.mergeRemoteUpdate).toHaveBeenCalledWith('note-1', delta)
  })

  it('#given a landing that throws #then the doc it opened is still closed', async () => {
    const { base, delta } = textUpdates()
    const provider = fakeProvider(new Map(), new Map([['note-1', base]]))
    provider.mergeRemoteUpdate.mockRejectedValueOnce(new Error('store write failed'))

    await expect(landNoteBody(deps(provider, ['note-1']), 'note-1', [delta])).rejects.toThrow(
      'store write failed'
    )
    expect(provider.closeIfInactive).toHaveBeenCalledWith('note-1')
  })
})
