import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { MicrotaskBatchBroadcaster } from './microtask-batch-broadcaster'

function makeUpdate(doc: Y.Doc, text: string): Uint8Array {
  const updates: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => updates.push(u))
  doc.getText('content').insert(doc.getText('content').length, text)
  doc.off('update', updates.push)
  return updates[0]
}

describe('MicrotaskBatchBroadcaster', () => {
  let broadcastFn: ReturnType<typeof vi.fn>
  let batcher: MicrotaskBatchBroadcaster

  beforeEach(() => {
    broadcastFn = vi.fn()
    batcher = new MicrotaskBatchBroadcaster(broadcastFn)
  })

  describe('#given multiple synchronous enqueues for same noteId #when microtask flushes', () => {
    it('#then produces exactly 1 broadcast call', async () => {
      // #given
      const doc = new Y.Doc()
      const updates = [makeUpdate(doc, 'Hello'), makeUpdate(doc, ' World'), makeUpdate(doc, '!')]

      // #when
      for (const u of updates) {
        batcher.enqueue('note-1', u)
      }
      await new Promise<void>((r) => queueMicrotask(r))

      // #then
      expect(broadcastFn).toHaveBeenCalledTimes(1)
      expect(broadcastFn).toHaveBeenCalledWith('note-1', expect.any(Uint8Array))
    })

    it('#then merged broadcast contains all content from individual updates', async () => {
      // #given
      const doc = new Y.Doc()
      const updates = [
        makeUpdate(doc, 'alpha'),
        makeUpdate(doc, '-beta'),
        makeUpdate(doc, '-gamma')
      ]

      // #when
      for (const u of updates) {
        batcher.enqueue('note-1', u)
      }
      await new Promise<void>((r) => queueMicrotask(r))

      // #then
      const mergedUpdate = broadcastFn.mock.calls[0][1] as Uint8Array
      const receiverDoc = new Y.Doc()
      Y.applyUpdate(receiverDoc, mergedUpdate)
      const received = receiverDoc.getText('content').toString()
      expect(received).toBe('alpha-beta-gamma')
    })
  })

  describe('#given enqueues for multiple noteIds #when microtask flushes', () => {
    it('#then broadcasts separately for each noteId', async () => {
      // #given
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()
      const u1 = makeUpdate(doc1, 'note-1 content')
      const u2 = makeUpdate(doc2, 'note-2 content')

      // #when
      batcher.enqueue('note-1', u1)
      batcher.enqueue('note-2', u2)
      await new Promise<void>((r) => queueMicrotask(r))

      // #then
      expect(broadcastFn).toHaveBeenCalledTimes(2)
      const calledNoteIds = broadcastFn.mock.calls.map((c: unknown[]) => c[0])
      expect(calledNoteIds).toContain('note-1')
      expect(calledNoteIds).toContain('note-2')
    })

    it('#then each broadcast only contains its own noteId updates', async () => {
      // #given
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()
      const u1 = makeUpdate(doc1, 'AAA')
      const u2 = makeUpdate(doc2, 'BBB')

      // #when
      batcher.enqueue('note-1', u1)
      batcher.enqueue('note-2', u2)
      await new Promise<void>((r) => queueMicrotask(r))

      // #then
      for (const [noteId, merged] of broadcastFn.mock.calls as [string, Uint8Array][]) {
        const receiver = new Y.Doc()
        Y.applyUpdate(receiver, merged)
        const text = receiver.getText('content').toString()
        if (noteId === 'note-1') expect(text).toBe('AAA')
        if (noteId === 'note-2') expect(text).toBe('BBB')
      }
    })
  })

  describe('#given a single enqueue #when microtask flushes', () => {
    it('#then passes through the update without merging', async () => {
      // #given
      const doc = new Y.Doc()
      const update = makeUpdate(doc, 'solo')

      // #when
      batcher.enqueue('note-1', update)
      await new Promise<void>((r) => queueMicrotask(r))

      // #then (single update is returned as-is, no Y.mergeUpdates call)
      const broadcastedUpdate = broadcastFn.mock.calls[0][1] as Uint8Array
      expect(broadcastedUpdate).toBe(update)
    })
  })

  describe('#given flush() called manually #when updates are pending', () => {
    it('#then broadcasts immediately without waiting for microtask', () => {
      // #given
      const doc = new Y.Doc()
      const u1 = makeUpdate(doc, 'first')
      const u2 = makeUpdate(doc, '-second')
      batcher.enqueue('note-1', u1)
      batcher.enqueue('note-1', u2)

      // #when
      batcher.flush('note-1')

      // #then
      expect(broadcastFn).toHaveBeenCalledTimes(1)
      const receiver = new Y.Doc()
      Y.applyUpdate(receiver, broadcastFn.mock.calls[0][1] as Uint8Array)
      expect(receiver.getText('content').toString()).toBe('first-second')
    })

    it('#then subsequent microtask does not double-broadcast', async () => {
      // #given
      const doc = new Y.Doc()
      batcher.enqueue('note-1', makeUpdate(doc, 'data'))

      // #when
      batcher.flush('note-1')
      await new Promise<void>((r) => queueMicrotask(r))

      // #then
      expect(broadcastFn).toHaveBeenCalledTimes(1)
    })
  })

  describe('#given flush() called with no pending updates', () => {
    it('#then does not broadcast', () => {
      // #when
      batcher.flush('nonexistent')

      // #then
      expect(broadcastFn).not.toHaveBeenCalled()
    })
  })

  describe('#given flushAll() called #when multiple noteIds have pending updates', () => {
    it('#then flushes all noteIds', () => {
      // #given
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()
      const doc3 = new Y.Doc()
      batcher.enqueue('n1', makeUpdate(doc1, 'A'))
      batcher.enqueue('n2', makeUpdate(doc2, 'B'))
      batcher.enqueue('n3', makeUpdate(doc3, 'C'))

      // #when
      batcher.flushAll()

      // #then
      expect(broadcastFn).toHaveBeenCalledTimes(3)
      const noteIds = broadcastFn.mock.calls.map((c: unknown[]) => c[0])
      expect(noteIds).toContain('n1')
      expect(noteIds).toContain('n2')
      expect(noteIds).toContain('n3')
    })
  })

  describe('#given hasPending query', () => {
    it('#then returns true when updates are queued', () => {
      // #given
      const doc = new Y.Doc()
      batcher.enqueue('note-1', makeUpdate(doc, 'x'))

      // #then
      expect(batcher.hasPending('note-1')).toBe(true)
      expect(batcher.hasPending('other')).toBe(false)
    })

    it('#then returns false after flush', () => {
      // #given
      const doc = new Y.Doc()
      batcher.enqueue('note-1', makeUpdate(doc, 'x'))

      // #when
      batcher.flush('note-1')

      // #then
      expect(batcher.hasPending('note-1')).toBe(false)
    })
  })

  describe('#given rapid enqueue-flush-enqueue cycle', () => {
    it('#then second batch gets its own broadcast', async () => {
      // #given
      const doc = new Y.Doc()
      batcher.enqueue('note-1', makeUpdate(doc, 'batch1'))

      // #when — flush first batch manually
      batcher.flush('note-1')
      // enqueue second batch (new microtask scheduled)
      batcher.enqueue('note-1', makeUpdate(doc, '-batch2'))
      await new Promise<void>((r) => queueMicrotask(r))

      // #then
      expect(broadcastFn).toHaveBeenCalledTimes(2)
    })
  })
})
