/**
 * What a portal block shows, decided without touching React or the editor.
 *
 * The inputs are facts the caller already holds (is the source note loaded,
 * is it locked, which portals enclose this one); the output is the one state
 * artboard 7 names. Pure, so every edge state has a unit test.
 *
 * @module note/content-area/portal/portal-state
 */

import { PORTAL_MAX_DEPTH, type PortalStatus, type PortalTarget } from '@memry/shared/portal-block'

/** A target a window can open: everything but a search. */
export type PortalWindowTarget = Exclude<PortalTarget, { kind: 'search' }>

/**
 * One level the reader is already inside.
 *
 * `window` frames are portal windows: whole-note (no `block`) or one block.
 * The `host` frame is the note holding the portal; it is ambient, not a
 * window, and does not count toward depth.
 */
export type PortalFrame =
  { kind: 'window'; note: string; block?: string } | { kind: 'host'; note: string }

export interface PortalAncestry {
  /** Outermost first. */
  frames: readonly PortalFrame[]
}

export const ROOT_PORTAL_ANCESTRY: PortalAncestry = { frames: [] }

/** Windows between the note being edited and this portal. */
export function portalWindowDepth(ancestry: PortalAncestry): number {
  return ancestry.frames.filter((frame) => frame.kind === 'window').length
}

/**
 * Would opening `target` show this portal inside itself?
 *
 * A whole-note target contains every portal in that note, so it loops against
 * any enclosing frame on the same note. A block target contains only its
 * subtree, so it loops only against a window on that same block. A block of
 * the host note, or of a note an enclosing whole-note window shows, is
 * allowed: it loops only if the portal sits inside that block, and then the
 * window it opens is the frame that catches it one level down.
 */
export function isPortalCycle(target: PortalWindowTarget, ancestry: PortalAncestry): boolean {
  return ancestry.frames.some((frame) => {
    if (frame.note !== target.note) return false
    if (target.kind === 'note') return true
    return frame.kind === 'window' && frame.block === target.block
  })
}

/** The ancestry inside the window a portal with `target` opens. */
export function descendPortalAncestry(
  ancestry: PortalAncestry,
  target: PortalWindowTarget
): PortalAncestry {
  const frame: PortalFrame =
    target.kind === 'block'
      ? { kind: 'window', note: target.note, block: target.block }
      : { kind: 'window', note: target.note }
  return { frames: [...ancestry.frames, frame] }
}

/** The ancestry as seen from a portal in `hostNoteId`, which is not itself in a window. */
export function withHostFrame(
  ancestry: PortalAncestry,
  hostNoteId: string | undefined
): PortalAncestry {
  if (!hostNoteId) return ancestry
  const last = ancestry.frames[ancestry.frames.length - 1]
  if (last && last.note === hostNoteId) return ancestry
  return { frames: [...ancestry.frames, { kind: 'host', note: hostNoteId }] }
}

export type PortalSourceLoad = 'loading' | 'found' | 'missing'

export interface PortalStatusInput {
  target: PortalWindowTarget
  ancestry: PortalAncestry
  source: PortalSourceLoad
  /** The index has no such note and sync is still pulling notes in. */
  syncing: boolean
  locked: boolean
  /**
   * Whether the anchored block is in the source's document: null until the
   * window has looked (and always null for a note target).
   */
  blockFound: boolean | null
}

export type PortalViewStatus = PortalStatus | 'loading'

export function resolvePortalStatus(input: PortalStatusInput): PortalViewStatus {
  const { target, ancestry, source, syncing, locked, blockFound } = input
  if (isPortalCycle(target, ancestry)) return 'cycle'
  if (portalWindowDepth(ancestry) >= PORTAL_MAX_DEPTH) return 'too-deep'
  if (source === 'loading') return 'loading'
  if (source === 'missing') return syncing ? 'not-synced' : 'missing-note'
  if (target.kind === 'block' && blockFound === false) return 'missing-block'
  return locked ? 'locked' : 'ok'
}

/** States where the source's content is not drawn at all. */
export function isPortalBlocked(status: PortalViewStatus): boolean {
  return status !== 'ok' && status !== 'locked' && status !== 'loading'
}
