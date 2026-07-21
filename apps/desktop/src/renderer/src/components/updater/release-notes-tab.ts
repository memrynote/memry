import type { AppUpdateState, UpdaterStatus } from '@memry/contracts/ipc-updater'

/** Statuses for which a real update has surfaced and its notes are worth showing. */
const SURFACING_STATUSES: ReadonlySet<UpdaterStatus> = new Set<UpdaterStatus>([
  'available',
  'downloading',
  'downloaded'
])

export interface ReleaseNotesTabPlan {
  /** Display version this tab is for (used for dedup + a unique tab path). */
  version: string
  /** Tab title, e.g. "memry note 2026.708.1". */
  title: string
  /** Release-notes body to render read-only. */
  content: string
  /** How `content` should be parsed by the note renderer. */
  contentType: 'html' | 'markdown'
}

/**
 * Decide whether the update flow should open a read-only "release notes" tab, and
 * with what content. Pure so it can be unit-tested and reused by the opener effect.
 *
 * Fires once per surfaced version (the caller tracks `surfacedVersion`), covering
 * both the prompt path and the silent auto-download path. Prefers the full HTML body
 * (keeps clickable PR references); falls back to the stripped plain-text notes.
 */
export function planReleaseNotesTab(
  state: AppUpdateState,
  surfacedVersion: string | null
): ReleaseNotesTabPlan | null {
  if (!state.updateSupported) return null

  const version = state.availableVersion
  if (!version) return null
  if (!SURFACING_STATUSES.has(state.status)) return null
  if (version === surfacedVersion) return null

  if (state.releaseNotesHtml) {
    return {
      version,
      title: `memry note ${version}`,
      content: state.releaseNotesHtml,
      contentType: 'html'
    }
  }

  if (state.releaseNotes) {
    return {
      version,
      title: `memry note ${version}`,
      content: state.releaseNotes,
      contentType: 'markdown'
    }
  }

  return null
}
