import { useEffect, useRef } from 'react'
import { useTabs } from '@/contexts/tabs'
import { createLogger } from '@/lib/logger'
import { planReleaseNotesTab } from './release-notes-tab'

const log = createLogger('Component:UpdateReleaseNotesTabOpener')

/**
 * Post-restart "what's new": on the first launch of a freshly installed version,
 * open a read-only "release notes" tab rendering the humanized notes (with
 * clickable PR links). Updates download and install silently, so this tab is the
 * moment the user learns anything changed — after the restart, never during the
 * background download. The tab is ephemeral (never written to the vault, never
 * synced, excluded from tab persistence); closing removes it, and
 * Cmd/Ctrl+Shift+T reopens it from the in-memory closed-tab stack.
 *
 * `consumeWhatsNew` clears the pending notes in main, so the tab opens exactly
 * once per installed version even across window reloads.
 * Renders nothing; must live inside TabProvider.
 */
export function UpdateReleaseNotesTabOpener(): null {
  const { openTab } = useTabs()
  const consumedRef = useRef(false)

  useEffect(() => {
    // StrictMode double-invokes effects; the consume is destructive, so run once.
    if (consumedRef.current) return
    consumedRef.current = true

    let cancelled = false
    void window.api.updater
      .consumeWhatsNew()
      .then((payload) => {
        if (cancelled) return
        const plan = planReleaseNotesTab(payload)
        if (!plan) return

        openTab({
          type: 'virtual-note',
          title: plan.title,
          icon: 'file-text',
          // Unique per version so distinct release-notes tabs never collapse into
          // one another via the no-entityId open/reopen dedup.
          path: `/virtual/release-notes/${plan.version}`,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false,
          viewState: { content: plan.content, contentType: plan.contentType }
        })
      })
      .catch((err) => {
        // Losing the what's-new tab is cosmetic; never let it break app mount.
        log.warn("failed to consume what's-new payload", err)
      })

    return () => {
      cancelled = true
    }
  }, [openTab])

  return null
}
