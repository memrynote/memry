import { useCallback } from 'react'
import { useTabs } from '@/contexts/tabs'
import { useT } from '@memry/i18n/renderer'
import type { ResolvedRelationRef } from '@memry/contracts/properties-api'

/**
 * Opens the target a relation chip points at. Shared by every surface that
 * renders relation chips (the note/journal property row and the folder-view
 * cell) so all of them navigate identically.
 *
 * Each kind rides a viewState contract the destination page already honours;
 * nothing new is introduced here:
 *
 * - note/file — a note or file tab, keyed by entityId so `openTab` dedups.
 * - task      — the tasks tab reads `openTaskId` (detail drawer) and
 *               `selectedProjectId` (scopes the list), the same pair
 *               `journal-day-panel` already sends.
 * - event     — the calendar reads `focusCalendarEventId`, `focusDate` and
 *               `focusedAt`. All three are required: its first effect needs the
 *               date to switch to day view and move the range, because its
 *               second effect can only find the event once the range that
 *               contains it has loaded. `focusedAt` is the re-trigger token —
 *               without a fresh one, a second click on the same event is a
 *               no-op, since both effects short-circuit on the consumed token.
 *
 * A dangling ref (`exists: false`) has nothing to open and is ignored.
 */
export function useRelationNavigation(): (ref: ResolvedRelationRef) => void {
  const { openTab } = useTabs()
  const { t } = useT('common')

  return useCallback(
    (ref: ResolvedRelationRef) => {
      if (!ref.exists) return

      const base = {
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      } as const

      if (ref.targetType === 'note') {
        // Files are note rows discriminated by fileType; markdown has none set.
        const isFile = Boolean(ref.fileType)
        openTab({
          ...base,
          type: isFile ? 'file' : 'note',
          title: ref.title,
          icon: isFile ? 'file' : 'file-text',
          path: isFile ? `/file/${ref.targetId}` : `/notes/${ref.targetId}`,
          entityId: ref.targetId,
          ...(ref.emoji ? { emoji: ref.emoji } : {})
        })
        return
      }

      if (ref.targetType === 'task') {
        openTab({
          ...base,
          type: 'tasks',
          title: t('phaseF.componentsTabsNewTabMenu.tasks'),
          icon: 'list-checks',
          path: '/tasks',
          viewState: {
            openTaskId: ref.targetId,
            // A task with no project leaves the list filter alone rather than
            // scoping it to nothing.
            ...(ref.projectId ? { selectedProjectId: ref.projectId } : {})
          }
        })
        return
      }

      openTab({
        ...base,
        type: 'calendar',
        title: t('phaseF.componentsTabsNewTabMenu.calendar'),
        icon: 'calendar',
        path: '/calendar',
        viewState: {
          focusCalendarEventId: ref.targetId,
          focusDate: ref.startAt,
          focusedAt: Date.now()
        }
      })
    },
    [openTab, t]
  )
}
