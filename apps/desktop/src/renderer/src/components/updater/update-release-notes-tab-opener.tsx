import { useEffect, useRef } from 'react'
import { useAppUpdater } from '@/hooks/use-app-updater'
import { useTabs } from '@/contexts/tabs'
import { stashReleaseNotes, takeReleaseNotesTabPlan } from './release-notes-tab'

/**
 * Tail end of the update flow: once the user has installed an update and restarted,
 * open the humanized release notes (with clickable PR links) as ONE extra read-only
 * tab, in the background. Existing tabs are untouched — nothing is replaced, nothing
 * is focused away from — and the tab is ephemeral (never written to the vault, never
 * synced, excluded from tab persistence), so closing it returns the user exactly
 * where they were.
 *
 * The notes themselves only exist while the pre-restart session holds the update
 * feed, so that session parks them (`stashReleaseNotes`) and the fresh session claims
 * them once its own version matches. Renders nothing; must live inside TabProvider.
 */
export function UpdateReleaseNotesTabOpener(): null {
  const { state } = useAppUpdater()
  const { openTab } = useTabs()
  const openedRef = useRef(false)

  // Park the notes of whatever update has surfaced, for the session that follows the
  // install. Harmless to repeat: same version overwrites the same entry.
  useEffect(() => {
    stashReleaseNotes(state)
  }, [state])

  useEffect(() => {
    if (openedRef.current) return
    if (!state.currentVersion || state.currentVersion === '0.0.0') return

    const plan = takeReleaseNotesTabPlan(state.currentVersion)
    if (!plan) return

    openedRef.current = true
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
        // Not a preview tab: a preview would take over the user's preview slot.
        isPreview: false,
        isDeleted: false,
        viewState: { content: plan.content, contentType: plan.contentType }
      },
      // The user did not ask for this tab; the updater did. `TabPane` mounts the
      // active tab alone, so focusing this one would unmount whatever the user is
      // typing in and discard its not-yet-persisted editor state.
      { background: true }
    )
  }, [state.currentVersion, openTab])

  return null
}
