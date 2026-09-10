import type { VaultDb } from '@/db/index'
import type { EditorDocManager, OpenDoc } from '@/editor/doc-manager'
import {
  cloneYSubtree,
  findBlockContainer,
  topBlockGroup,
  trailingEmptyParagraphIndex
} from '@/editor/clone-y-subtree'
import { extractErrorMessage } from '@/lib/errors'
import { materializedBody, readNoteRecord, resolveSeedMarkdown } from './note-ops'

export interface MoveBlockContext {
  docs: EditorDocManager
  db: VaultDb
}

export type MoveBlockOutcome = { status: 'ok' } | { status: 'error'; detail: string }

/**
 * Move one block into another note (#2100) — the HOST half.
 *
 * The division is forced: the guest cannot reach the target note's Y.Doc, and
 * the host cannot build a block. So the host copies a subtree the guest's own
 * schema produced, and the guest deletes the source once this resolves `ok`.
 *
 * The source note is NOT touched here. That is deliberate — the target write
 * cannot be rolled back, so the delete has to be second, and a lost answer
 * then duplicates a block rather than losing one.
 */
export async function moveBlockToNote(
  ctx: MoveBlockContext,
  args: { sourceDoc: OpenDoc; blockId: string; targetNoteId: string }
): Promise<MoveBlockOutcome> {
  const { sourceDoc, blockId, targetNoteId } = args

  // The picker already excludes the current note; this is the belt, because a
  // block cloned into its own document would arrive as a duplicate that the
  // guest's delete then removes at random.
  if (targetNoteId === sourceDoc.docId) {
    return { status: 'error', detail: 'That block is already in this note' }
  }

  let unpin: (() => void) | null = null
  try {
    const target = await ctx.docs.openDoc(targetNoteId)
    // PIN the target IMMEDIATELY, before any further await. `inUse()` reads the
    // listener sets, and nothing is mounted on this doc — so without a
    // subscriber a concurrent `openDoc` past `MAX_OPEN_DOCS` may evict and
    // DESTROY it while this is still reading the seed guard or committing, and
    // the update would then land on a dead doc with the row already on disk.
    unpin = target.onLocalUpdate(() => {})

    const seedBlocked = await wouldDestroyASeed(ctx.db, target, targetNoteId)
    if (seedBlocked) return { status: 'error', detail: seedBlocked }

    await target.applyFromHost((draft) => {
      // The source is read HERE, inside the write, and not once at the top:
      // opening the target and reading the seed guard both await, and a pull
      // landing in that window can remove the block. A container captured
      // before the await would still be a live Y type with nothing left in it,
      // and the clone would put an EMPTY blockContainer into the target — a
      // block BlockNote cannot render, on every device, while the guest went
      // on to delete the original.
      const src = findBlockContainer(sourceDoc.doc, blockId)
      if (!src) throw new Error('That block is no longer in this note')
      const group = topBlockGroup(draft)
      // An empty fragment is a note whose body has never been materialized
      // into CRDT; minting a blockGroup for it here is the same seed
      // destruction the guard above refuses.
      if (!group) throw new Error('That note has no body yet')
      const trailing = trailingEmptyParagraphIndex(group)
      const write = cloneYSubtree(src)
      if (trailing === null) write(group)
      else write(group, trailing)
    })

    return { status: 'ok' }
  } catch (err) {
    return { status: 'error', detail: extractErrorMessage(err, 'That block could not be moved') }
  } finally {
    unpin?.()
  }
}

/**
 * The SEED GUARD, and it is not optional.
 *
 * A note whose CRDT doc is empty can still have a real body: in `note_bodies`
 * from the record applier's create-time `content`, or behind the `meta` marker
 * `resolveSeedMarkdown` reads. Both reach the editor only through `doc-load`'s
 * `seedMarkdown`, which the guest applies ONLY when the doc is genuinely empty.
 * Appending a block into that doc makes it non-empty, the seed is skipped for
 * ever, and the target note's real body is destroyed on every device.
 *
 * The condition is the BODY, not the marker: the marker only covers notes this
 * device created, while `note_bodies` covers the rest, and both funnel through
 * the same emptiness gate.
 */
async function wouldDestroyASeed(
  db: VaultDb,
  target: OpenDoc,
  targetNoteId: string
): Promise<string | null> {
  if (!target.isEmpty()) return null

  const [body, pendingSeed] = await Promise.all([
    materializedBody(db, targetNoteId),
    resolveSeedMarkdown(db, targetNoteId)
  ])
  if (!body && !pendingSeed) return null

  const record = await readNoteRecord(db, targetNoteId)
  const title = record?.payload.title ?? 'that note'
  return `Open "${title}" once, then move the block`
}
