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
  /** The local row holding the day is foreign and leaves before anything is written. */
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
  return { applyIncoming: incomingId === canonical, oweMerge, removeHolder: holderForeign }
}
