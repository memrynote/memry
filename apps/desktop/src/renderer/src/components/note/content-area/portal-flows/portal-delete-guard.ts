/**
 * What a delete would take away from other notes. A source block shown by a
 * portal is addressed by the ` ^anchor` its text ends with, so the question
 * "who sees this block" is a usage lookup per anchor in the deleted subtree.
 * Pure helpers here; the dialog and the editor wiring live beside them.
 *
 * @module note/content-area/portal-flows/portal-delete-guard
 */

import { extractAnchor } from '@memry/shared/portal-block'
import type { PortalHost } from './portal-api'

/** The slice of a BlockNote block the guard reads. */
export interface GuardBlock {
  id: string
  content?: unknown
  children?: readonly GuardBlock[]
}

/** A block's inline text, runs and links flattened. */
export function guardBlockText(block: GuardBlock): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((node: unknown) => {
      if (typeof node === 'string') return node
      if (typeof node !== 'object' || node === null) return ''
      const run = node as { text?: unknown; content?: unknown }
      if (typeof run.text === 'string') return run.text
      return Array.isArray(run.content) ? guardBlockText({ id: '', content: run.content }) : ''
    })
    .join('')
}

/** Anchors carried by these blocks and everything under them, in document order. */
export function collectAnchors(blocks: readonly GuardBlock[]): string[] {
  const anchors: string[] = []
  const visit = (block: GuardBlock): void => {
    const anchor = extractAnchor(guardBlockText(block))
    if (anchor) anchors.push(anchor)
    block.children?.forEach(visit)
  }
  blocks.forEach(visit)
  return anchors
}

/**
 * One row per host note, counts added up, from per-anchor usage lookups. The
 * source itself never counts: a portal to your own block is refused at insert.
 */
export function mergeHosts(
  sourceNoteId: string,
  lists: readonly (readonly PortalHost[])[]
): PortalHost[] {
  const byNote = new Map<string, PortalHost>()
  for (const host of lists.flat()) {
    if (host.noteId === sourceNoteId) continue
    const seen = byNote.get(host.noteId)
    byNote.set(host.noteId, seen ? { ...seen, count: seen.count + host.count } : host)
  }
  return [...byNote.values()]
}

/** Hosts that show any anchored block in `blocks` of `sourceNoteId`. */
export async function findBlockHosts(
  sourceNoteId: string,
  blocks: readonly GuardBlock[],
  getUsage: (noteId: string, anchor: string) => Promise<PortalHost[]>
): Promise<PortalHost[]> {
  const anchors = collectAnchors(blocks)
  if (anchors.length === 0) return []
  return mergeHosts(
    sourceNoteId,
    await Promise.all(anchors.map((anchor) => getUsage(sourceNoteId, anchor)))
  )
}
