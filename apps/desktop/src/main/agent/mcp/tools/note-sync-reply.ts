import type { NoteSyncState } from '@memry/contracts/ipc-sync-ops'
import { createLogger } from '../../../lib/logger'
import type { NoteSyncReply, VaultServiceHandles } from './handles'

const log = createLogger('AgentNoteSync')

export function toNoteSyncReply(state: NoteSyncState): NoteSyncReply {
  const reply: NoteSyncReply = { state: state.state }
  const times: Array<[Exclude<keyof NoteSyncReply, 'state'>, number | null]> = [
    ['waiting_since', state.waitingSince],
    ['last_sent_at', state.lastSentAt],
    ['body_confirmed_at', state.bodyConfirmedAt],
    ['last_failed_at', state.lastFailedAt],
    ['last_rejected_at', state.lastRejectedAt]
  ]
  for (const [key, at] of times) if (at !== null) reply[key] = new Date(at).toISOString()
  return reply
}

/**
 * Add `sync` to each item whose id has a note. A read never fails because its
 * sync state could not be read: the items come back without it.
 */
export async function withNoteSync<T extends { id: string }>(
  handles: VaultServiceHandles,
  items: T[],
  isNote: (item: T) => boolean = () => true
): Promise<Array<T & { sync?: NoteSyncReply }>> {
  const ids = items.filter(isNote).map((item) => item.id)
  if (ids.length === 0) return items
  let states: Record<string, NoteSyncReply>
  try {
    states = await handles.sync.noteStates(ids)
  } catch (err) {
    log.warn('Could not read note sync states for an agent reply', {
      count: ids.length,
      error: err
    })
    return items
  }
  return items.map((item) => {
    const sync = isNote(item) ? states[item.id] : undefined
    return sync ? { ...item, sync } : item
  })
}
