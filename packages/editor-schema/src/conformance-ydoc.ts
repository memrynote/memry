/**
 * Turning the {@link NOTE_BLOCK_CASES} corpus into real `prosemirror` bytes.
 *
 * **Separate from `conformance.ts` on purpose.** Two desktop suites import
 * that file for `ROUNDTRIP_CASES`, and `@blocknote/server-util` drags in
 * jsdom and the whole editor. Keeping the import here means the corpus stays
 * cheap for its existing consumers and only the vector generator pays.
 *
 * **Why it goes through BlockNote at all.** Rule 1 of
 * `packages/contracts/test-vectors/README.md`: a generator that reimplements
 * the algorithm proves the generator. Hand-building `Y.XmlElement`s would pin
 * what someone believed y-prosemirror writes; `blocksToYXmlFragment` pins what
 * desktop actually writes, which is the thing a second port has to read.
 *
 * The client id is pinned for the same reason every other class pins one: an
 * update encodes it, so an unpinned document makes the class non-reproducible
 * and silently exempt from `vectors:check`.
 */
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import * as Y from 'yjs'

import { NOTE_BLOCK_CASES, type NoteBlockCase } from './conformance'
import { createMemrySchema } from './schema'
import { createServerBlockSpecs, createServerInlineSpecs } from './server'

/** Chapter 12 §12.3. The same string `CRDT_FRAGMENT_NAME` carries. */
export const CONFORMANCE_FRAGMENT = 'prosemirror'

/**
 * The value every generated document's `clientID` takes.
 *
 * Arbitrary; only its fixedness matters. `0x6d656d72` is what the sibling
 * classes use, and sharing it keeps one fact in one shape.
 */
export const CONFORMANCE_CLIENT_ID = 0x6d656d72

let editor: ServerBlockNoteEditor | null = null

/**
 * The same schema desktop's main process builds.
 *
 * Built once: `ServerBlockNoteEditor.create` stands up a jsdom document, and
 * doing that per case turns a 30-case generator into a minute of work.
 */
function serverEditor(): ServerBlockNoteEditor {
  if (!editor) {
    const schema = createMemrySchema({
      blocks: createServerBlockSpecs(),
      inline: createServerInlineSpecs()
    })
    editor = ServerBlockNoteEditor.create({ schema }) as ServerBlockNoteEditor
  }
  return editor
}

/**
 * Gives every block a deterministic id, in place of the v4 UUID BlockNote
 * would mint.
 *
 * **Without this the class is not reproducible.** `blocksToYXmlFragment`
 * stamps a fresh UUID on every `blockContainer` that arrives without an id,
 * so two runs of the generator produce different bytes and `vectors:check`
 * fails on a tree nobody touched — which would quietly exempt this class from
 * the one gate it exists to be caught by.
 *
 * A block id is opaque, so fixing it changes nothing a reader can observe. It
 * also makes the id an **input**: a write-direction case that asserts where a
 * block landed names it rather than discovering it.
 */
function withIds(blocks: unknown[], prefix: string): unknown[] {
  return blocks.map((block, index) => {
    if (block === null || typeof block !== 'object') return block
    const entry = block as Record<string, unknown> & { children?: unknown[] }
    const id = `${prefix}-${index}`
    return {
      ...entry,
      id,
      ...(Array.isArray(entry.children) ? { children: withIds(entry.children, id) } : {})
    }
  })
}

/** A case name as an id-safe slug. */
function slug(name: string): string {
  return name
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

/**
 * One case as a `Y.Doc` whose `prosemirror` fragment holds its blocks.
 *
 * An empty case is a document with an empty fragment, not a document with one
 * empty paragraph: "nobody has written this note" and "this note holds one
 * blank line" are different facts and the read path must keep them apart.
 */
export function noteBlockDoc(entry: NoteBlockCase): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = CONFORMANCE_CLIENT_ID
  const fragment = doc.getXmlFragment(CONFORMANCE_FRAGMENT)
  if (entry.blocks.length > 0) {
    // The production path, not a hand-built tree: this is what desktop's
    // main process calls, so the bytes are the bytes a real note carries.
    serverEditor().blocksToYXmlFragment(withIds(entry.blocks, slug(entry.name)) as never, fragment)
  }
  return doc
}

/** Every case, with its document. */
export function noteBlockDocs(): Array<{ entry: NoteBlockCase; doc: Y.Doc }> {
  return NOTE_BLOCK_CASES.map((entry) => ({ entry, doc: noteBlockDoc(entry) }))
}
