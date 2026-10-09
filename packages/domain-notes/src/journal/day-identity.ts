/**
 * One journal item per day (protocol §1.9.1, #2939).
 *
 * A day's id is `j<YYYY-MM-DD>` on every device. A journal item with any other
 * id for that day is foreign: it is never projected as a row, its body is
 * merged into the canonical day and the foreign id is tombstoned. This is the
 * apply-time decision both desktop and the core make, pinned by the `journal`
 * vector class (`dayIdentity`).
 */
import { generateJournalId } from '@memry/contracts/journal-api'

export interface JournalDayApplyPlan {
  /** Apply the incoming item as the day's row. Only the canonical id is applied. */
  applyIncoming: boolean
  /** Foreign ids whose body is owed to the canonical day, then a tombstone. */
  oweMerge: string[]
  /**
   * The local row holding the day is foreign and gives the path to the incoming
   * canonical item. Only when the incoming item is applied: a foreign row stays
   * until the drain sweeps it, so no day file is left without a row (#2985).
   */
  removeHolder: boolean
}

/**
 * @param incomingId the journal id being applied
 * @param date the incoming item's day
 * @param holderId the id of the local row that holds `date`, or null
 */
export function planJournalDayApply(
  incomingId: string,
  date: string,
  holderId: string | null
): JournalDayApplyPlan {
  const canonical = generateJournalId(date)
  const holderForeign = holderId !== null && holderId !== canonical
  const oweMerge: string[] = []
  if (incomingId !== canonical) oweMerge.push(incomingId)
  if (holderForeign && holderId !== incomingId) oweMerge.push(holderId)
  const applyIncoming = incomingId === canonical
  return { applyIncoming, oweMerge, removeHolder: holderForeign && applyIncoming }
}

/** What the drain does next with one owed merge `F -> D` (§1.9.1). */
export type JournalDayMergeAction =
  /** Stays owed: `F`'s server body has not fully arrived. */
  | 'wait'
  /**
   * Settles without folding: `F` holds nothing here, neither Yjs state nor
   * text. `F` is not tombstoned: a device that holds its text may not have
   * pushed it.
   */
  | 'forget'
  /**
   * `j<D>` is deleted on this device: it is not re-created. `F` settles
   * untouched and stays live, so no text it holds is deleted.
   */
  | 'drop'
  /** Ensure `j<D>`, relink tasks, fold `F` into it. */
  | 'merge'

export interface JournalDayMergeStep {
  action: JournalDayMergeAction
  /** Queue `F`'s tombstone at `increment(F.clock, self)`. Only after a merge. */
  tombstone: boolean
}

export interface JournalDayMergeState {
  /** `F`'s tombstone arrived: another device merged it. */
  deleted: boolean
  /** `F`'s server body is fully merged locally. Not pulled, and true, when `deleted`. */
  bodyPulled: boolean
  /**
   * `F` has a body to fold: Yjs state, or text to build it from (a local
   * holder's day file, or, while `F` is live, its record's `content`).
   */
  hasBody: boolean
  /** `j<D>` has no live row and a recorded tombstone on this device. */
  dayDeleted: boolean
  /** `F`'s clock is non-empty, so the server has seen `F`. */
  clocked: boolean
}

/**
 * The drain's decision for one owed merge, shared by desktop and the core and
 * pinned by the `dayMerge` vectors. Order: body pulled, body present, day
 * deleted, then merge. A tombstone is owed only when a live, clocked `F` was
 * merged: its text is then in `j<D>`, so deleting `F` hides nothing.
 */
export function planJournalDayMerge(state: JournalDayMergeState): JournalDayMergeStep {
  if (!state.deleted && !state.bodyPulled) return { action: 'wait', tombstone: false }
  if (!state.hasBody) return { action: 'forget', tombstone: false }
  if (state.dayDeleted) return { action: 'drop', tombstone: false }
  return { action: 'merge', tombstone: !state.deleted && state.clocked }
}
