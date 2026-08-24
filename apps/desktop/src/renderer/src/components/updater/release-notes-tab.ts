import type { WhatsNewPayload } from '@memry/contracts/ipc-updater'

export interface ReleaseNotesTabPlan {
  /** Display version this tab is for (used for a unique tab path). */
  version: string
  /** Tab title, e.g. "MemryNote 2026.708.1". */
  title: string
  /** Release-notes body to render read-only. */
  content: string
  /** How `content` should be parsed by the note renderer. */
  contentType: 'html' | 'markdown'
}

/**
 * Shape the post-restart "what's new" payload into the read-only release-notes
 * tab. Pure so it can be unit-tested and reused by the opener effect. The
 * WHEN is decided in the main process (`consumeWhatsNew`): the payload only
 * exists on the first launch of a freshly installed version, so the tab opens
 * after the restart that applied the update — never while one is downloading.
 */
export function planReleaseNotesTab(payload: WhatsNewPayload | null): ReleaseNotesTabPlan | null {
  if (!payload?.content) return null
  return {
    version: payload.version,
    title: `MemryNote ${payload.version}`,
    content: payload.content,
    contentType: payload.contentType
  }
}
