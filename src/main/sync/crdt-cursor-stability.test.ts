import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'

/**
 * T193a: Verifies CRDT merge behavior that underpins cursor stability.
 *
 * When multiple remote updates arrive for the same note, the CrdtProvider
 * batches them via queueMicrotask + Y.mergeUpdates before broadcasting
 * to the renderer. This test suite verifies:
 *
 * 1. Merged updates produce identical doc state to sequential applies
 * 2. Local edits interleaved with remote updates don't lose data
 * 3. Batching reduces the number of update events fired
 */
describe('CRDT cursor stability', () => {
  describe('#given multiple sequential remote updates #when merged into single update', () => {
    it('#then produces identical document state', () => {
      // #given — simulate main process doc receiving N remote updates
      const mainDoc = new Y.Doc()
      const remoteDoc = new Y.Doc()
      const updates: Uint8Array[] = []

      // Generate 5 sequential edits from "remote" device
      const remoteText = remoteDoc.getText('content')
      remoteDoc.on('update', (update: Uint8Array) => {
        updates.push(update)
      })

      remoteText.insert(0, 'Hello')
      remoteText.insert(5, ' World')
      remoteText.insert(11, '!')
      remoteText.delete(0, 5)
      remoteText.insert(0, 'Greetings')

      expect(updates.length).toBe(5)

      // #when — apply all updates sequentially to main doc (simulates applyRemoteUpdate loop)
      for (const u of updates) {
        Y.applyUpdate(mainDoc, u)
      }

      // Also create a "renderer doc" that receives the merged update (simulates batched broadcast)
      const rendererDoc = new Y.Doc()
      const merged = Y.mergeUpdates(updates)
      Y.applyUpdate(rendererDoc, merged)

      // #then — both should have identical content
      const mainContent = mainDoc.getText('content').toString()
      const rendererContent = rendererDoc.getText('content').toString()
      expect(mainContent).toBe('Greetings World!')
      expect(rendererContent).toBe(mainContent)
    })
  })

  describe('#given local edits interleaved with remote updates', () => {
    it('#then both local and remote changes are preserved after merge', () => {
      // #given — two devices editing concurrently
      const localDoc = new Y.Doc({ guid: 'note-1' })
      const remoteDoc = new Y.Doc({ guid: 'note-1' })

      const localText = localDoc.getText('content')
      const remoteText = remoteDoc.getText('content')

      // Initial shared state
      localText.insert(0, 'Hello World')
      const initialUpdate = Y.encodeStateAsUpdate(localDoc)
      Y.applyUpdate(remoteDoc, initialUpdate)

      // Remote makes edits
      const remoteUpdates: Uint8Array[] = []
      remoteDoc.on('update', (update: Uint8Array) => {
        remoteUpdates.push(update)
      })
      remoteText.insert(11, ' from remote')

      // Local makes concurrent edit
      localText.insert(5, ' Beautiful')

      // #when — apply remote updates to local doc (simulates sync pull)
      const mergedRemote = Y.mergeUpdates(remoteUpdates)
      Y.applyUpdate(localDoc, mergedRemote, 'remote')

      // #then — both edits preserved via CRDT merge
      const result = localText.toString()
      expect(result).toContain('Beautiful')
      expect(result).toContain('from remote')
    })
  })

  describe('#given batched broadcast via queueMicrotask', () => {
    it('#then only one merged broadcast fires per microtask turn', async () => {
      // #given — simulate CrdtProvider's batching mechanism
      const doc = new Y.Doc()
      const text = doc.getText('content')
      const broadcasts: Uint8Array[] = []
      let pendingUpdates: Uint8Array[] = []
      let flushScheduled = false

      const queueBroadcast = (update: Uint8Array): void => {
        pendingUpdates.push(update)
        if (!flushScheduled) {
          flushScheduled = true
          queueMicrotask(() => {
            flushScheduled = false
            const merged =
              pendingUpdates.length === 1 ? pendingUpdates[0] : Y.mergeUpdates(pendingUpdates)
            pendingUpdates = []
            broadcasts.push(merged)
          })
        }
      }

      // #when — apply 10 updates synchronously (same microtask turn)
      for (let i = 0; i < 10; i++) {
        doc.transact(() => {
          text.insert(text.length, `line${i}\n`)
        })
      }

      // Capture updates from the doc
      const allUpdates: Uint8Array[] = []
      const freshDoc = new Y.Doc()
      const freshText = freshDoc.getText('content')
      freshDoc.on('update', (u: Uint8Array) => allUpdates.push(u))

      for (let i = 0; i < 10; i++) {
        freshDoc.transact(() => {
          freshText.insert(freshText.length, `line${i}\n`)
        })
      }

      // Queue all captured updates
      for (const u of allUpdates) {
        queueBroadcast(u)
      }

      // #then — wait for microtask flush
      await new Promise<void>((r) => queueMicrotask(r))

      expect(broadcasts.length).toBe(1)

      // Verify the single merged broadcast contains all content
      const receiverDoc = new Y.Doc()
      Y.applyUpdate(receiverDoc, broadcasts[0])
      const received = receiverDoc.getText('content').toString()
      for (let i = 0; i < 10; i++) {
        expect(received).toContain(`line${i}`)
      }
    })
  })

  describe('#given XmlFragment edits from remote #when merged', () => {
    it('#then structural positions are preserved for cursor mapping', () => {
      // #given — XmlFragment (what BlockNote uses) with existing content
      const localDoc = new Y.Doc()
      const remoteDoc = new Y.Doc()

      const localFrag = localDoc.getXmlFragment('document-store')
      const remoteFrag = remoteDoc.getXmlFragment('document-store')

      // Create initial structure: two paragraphs
      localDoc.transact(() => {
        const p1 = new Y.XmlElement('paragraph')
        p1.insert(0, [new Y.XmlText('First paragraph')])
        const p2 = new Y.XmlElement('paragraph')
        p2.insert(0, [new Y.XmlText('Second paragraph')])
        localFrag.insert(0, [p1, p2])
      })

      // Sync initial state
      Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(localDoc))

      // Remote adds a third paragraph
      const remoteUpdates: Uint8Array[] = []
      remoteDoc.on('update', (u: Uint8Array) => remoteUpdates.push(u))

      remoteDoc.transact(() => {
        const p3 = new Y.XmlElement('paragraph')
        p3.insert(0, [new Y.XmlText('Third from remote')])
        remoteFrag.insert(remoteFrag.length, [p3])
      })

      // Local user edits first paragraph (cursor is here)
      localDoc.transact(() => {
        const p1 = localFrag.get(0) as Y.XmlElement
        const textNode = p1.get(0) as Y.XmlText
        textNode.insert(textNode.length, ' (edited)')
      })

      // #when — apply merged remote updates
      const merged = Y.mergeUpdates(remoteUpdates)
      Y.applyUpdate(localDoc, merged, 'remote')

      // #then — local edit preserved AND remote paragraph added
      const p1 = localFrag.get(0) as Y.XmlElement
      const p1Text = (p1.get(0) as Y.XmlText).toString()
      expect(p1Text).toBe('First paragraph (edited)')

      expect(localFrag.length).toBe(3)
      const p3 = localFrag.get(2) as Y.XmlElement
      const p3Text = (p3.get(0) as Y.XmlText).toString()
      expect(p3Text).toBe('Third from remote')
    })
  })
})
