import { isCommandId, type CommandId } from '@memry/contracts/commands'

export const COMMAND_RECENTS_KEY = 'memry:command-recents'
const MAX_RECENTS = 5

/**
 * Recently run commands, most recent first. Tolerates anything an older build,
 * another window or a hand edit left behind, and drops ids this build no longer has.
 */
export function readCommandRecents(): CommandId[] {
  try {
    const raw = localStorage.getItem(COMMAND_RECENTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isCommandId).slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

export function recordCommandRecent(id: CommandId): void {
  const next = [id, ...readCommandRecents().filter((existing) => existing !== id)].slice(
    0,
    MAX_RECENTS
  )
  try {
    localStorage.setItem(COMMAND_RECENTS_KEY, JSON.stringify(next))
  } catch {
    // Storage full or unavailable: recents are a convenience, not state.
  }
}
