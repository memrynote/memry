/**
 * The write-back's guard against writing a forked note body over its file.
 *
 * A BlockNote body is one root `blockGroup` in the note fragment. A doc seeded
 * from the vault file beside a server body it shares no Yjs items with holds
 * two (#2536). A pass serializes only the first, so its write drops the
 * other's text. The editor deletes one of the two, and that deletion syncs. A
 * device whose doc is then left with no root gets a fresh, empty one from its
 * editor, and writing it empties a file that holds the whole note.
 *
 * So a pass keeps the file and logs an error when the doc holds more than one
 * live root, or when it would write an empty body over a file with text under
 * a root the doc held neither at open (`holdOpenRoots`) nor at this module's
 * last write. A user who clears a note keeps its root, so that write goes
 * ahead. Nothing is repaired or moved: the file stays as it is until a doc
 * with one root writes it.
 *
 * @module sync/crdt-root-guard
 */

import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { countWords } from '@memry/contracts/journal-api'
import { createLogger } from '../lib/logger'

const log = createLogger('CrdtWriteback')

interface HeldRoots {
  /** Every root the doc held once it was open and ready; see `holdOpenRoots`. */
  open: Set<string>
  /** The one root of the doc state this module last wrote, or found already in the file. */
  written: string | null
}

const heldRoots = new WeakMap<Y.Doc, HeldRoots>()
/** The roots each kept file was last logged for, so a note logs once per state. */
const logged = new Map<string, string>()

/** The live root block groups of the doc's note fragment, by Yjs item id. */
export function liveRootKeys(doc: Y.Doc): string[] {
  const keys: string[] = []
  for (const node of doc.getXmlFragment(CRDT_FRAGMENT_NAME).toArray()) {
    const id =
      node instanceof Y.XmlElement && node.nodeName === 'blockGroup' ? node._item?.id : null
    if (id) keys.push(`${id.client}:${id.clock}`)
  }
  return keys
}

/**
 * For the CRDT provider: `doc` is open and ready, loaded from the store or
 * seeded at open, seeded later from its file, or filled by the server merge
 * it waited for. The roots it holds now are its own.
 */
export function holdOpenRoots(doc: Y.Doc): void {
  let held = heldRoots.get(doc)
  if (!held) {
    held = { open: new Set(), written: null }
    heldRoots.set(doc, held)
  }
  for (const key of liveRootKeys(doc)) held.open.add(key)
}

/** The file now holds the doc state whose live roots were `roots`. */
export function recordWrittenRoots(doc: Y.Doc, roots: string[]): void {
  const held = heldRoots.get(doc)
  if (held && roots.length === 1) held.written = roots[0]
}

/** Whether the doc still writes under a root it held. A doc the provider never opened has none to compare. */
function keepsItsRoot(doc: Y.Doc, roots: string[]): boolean {
  const held = heldRoots.get(doc)
  if (!held) return true
  return roots.length === 1 && (held.open.has(roots[0]) || held.written === roots[0])
}

/**
 * True when the pass must leave the note's file alone: `roots` are the doc's
 * live roots when `body` was serialized, and `readFileBody` reads the body of
 * the file the pass would replace.
 */
export async function keepsFileOverForkedBody(
  noteId: string,
  doc: Y.Doc,
  roots: string[],
  body: string,
  readFileBody: () => Promise<string | null>
): Promise<boolean> {
  const forked = roots.length > 1
  if (!forked && (body.trim() !== '' || keepsItsRoot(doc, roots))) {
    logged.delete(noteId)
    return false
  }
  const fileBody = (await readFileBody()) ?? ''
  if (!forked && fileBody.trim() === '') {
    logged.delete(noteId)
    return false
  }
  const state = roots.join(',')
  if (logged.get(noteId) !== state) {
    logged.set(noteId, state)
    log.error(
      forked
        ? 'Write-back kept the file: the note body holds more than one root'
        : 'Write-back kept the file: an empty body under a root the note did not hold',
      {
        noteId,
        liveRoots: roots.length,
        bodyWords: countWords(body),
        fileWords: countWords(fileBody)
      }
    )
  }
  return true
}

export function resetRootGuardState(): void {
  logged.clear()
}
