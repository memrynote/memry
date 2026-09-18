import type { AppUpdateState } from '@memry/contracts/ipc-updater'

/**
 * Release notes are only known while the OLD session still runs (the update feed
 * carries them); after the install + restart the new session sees `up-to-date` and
 * no notes at all. So the pre-restart session parks them here, and the fresh session
 * picks them up when its own version matches what was parked.
 */
const STORAGE_KEY = 'memry:release-notes-pending'

export interface ReleaseNotesTabPlan {
  /** Display version this tab is for (used for dedup + a unique tab path). */
  version: string
  /** Tab title, e.g. "MemryNote 2026.708.1". */
  title: string
  /** Release-notes body to render read-only. */
  content: string
  /** How `content` should be parsed by the note renderer. */
  contentType: 'html' | 'markdown'
}

interface StashedNotes {
  version: string
  content: string
  contentType: 'html' | 'markdown'
}

const normalize = (version: string): string => version.trim().replace(/^v/i, '')

/**
 * Park the notes of an update that has surfaced, so the post-install session can show
 * them. Prefers the full HTML body (keeps clickable PR references); falls back to the
 * stripped plain-text notes.
 */
export function stashReleaseNotes(state: AppUpdateState): void {
  if (!state.updateSupported) return
  const version = state.availableVersion
  if (!version) return
  const content = state.releaseNotesHtml || state.releaseNotes
  if (!content) return

  const stash: StashedNotes = {
    version: normalize(version),
    content,
    contentType: state.releaseNotesHtml ? 'html' : 'markdown'
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stash))
  } catch {
    // Quota/private-mode failures just mean no notes tab; never break the update flow.
  }
}

/**
 * Consume parked notes when the running version is the one they belong to — i.e. the
 * user installed the update and restarted. Clears the stash so the tab opens exactly
 * once per release, no matter how often the app restarts afterwards.
 */
export function takeReleaseNotesTabPlan(currentVersion: string): ReleaseNotesTabPlan | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null

  let stash: Partial<StashedNotes> | null = null
  try {
    stash = JSON.parse(raw) as Partial<StashedNotes>
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }

  if (!stash || typeof stash.version !== 'string' || typeof stash.content !== 'string') {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
  // Still on the old version: the install has not happened yet, keep waiting.
  if (stash.version !== normalize(currentVersion)) return null

  localStorage.removeItem(STORAGE_KEY)
  return {
    version: stash.version,
    title: `MemryNote ${stash.version}`,
    content: stash.content,
    contentType: stash.contentType === 'markdown' ? 'markdown' : 'html'
  }
}
