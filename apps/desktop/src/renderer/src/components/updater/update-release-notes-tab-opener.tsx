import { useEffect, useRef } from 'react'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { useTabs } from '@/contexts/tabs'
import { planReleaseNotesTab } from './release-notes-tab'

/**
 * Part of the update flow: when a new release surfaces — whether the prompt is shown
 * or a silent auto-download begins — open a read-only "release notes" tab rendering
 * the humanized notes (with clickable PR links) in the BACKGROUND. The tab is
 * ephemeral (never written to the vault, never synced, excluded from tab
 * persistence); closing removes it, and Cmd/Ctrl+Shift+T reopens it from the
 * in-memory closed-tab stack.
 *
 * Opens once per surfaced version so short-interval polling never re-opens it.
 * Renders nothing; must live inside TabProvider.
 */
export function UpdateReleaseNotesTabOpener(): null {
  const { state } = useAppUpdater()
  const { openTab } = useTabs()
  const surfacedVersionRef = useRef<string | null>(null)

  useEffect(() => {
    const plan = planReleaseNotesTab(state, surfacedVersionRef.current)
    if (!plan) return

    surfacedVersionRef.current = plan.version
    openTab(
      {
        type: 'virtual-note',
        title: plan.title,
        icon: 'file-text',
        // Unique per version so distinct release-notes tabs never collapse into one
        // another via the no-entityId open/reopen dedup.
        path: `/virtual/release-notes/${plan.version}`,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { content: plan.content, contentType: plan.contentType }
      },
      // The user did not ask for this tab; the release poller did. `TabPane` mounts
      // the active tab alone, so focusing this one would unmount whatever the user
      // is typing in and discard its not-yet-persisted editor state.
      { background: true }
    )
  }, [state, openTab])

  return null
}
