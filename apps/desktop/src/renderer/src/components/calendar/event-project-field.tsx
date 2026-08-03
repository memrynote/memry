import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

import { ProjectPicker } from '@/components/tasks/project-picker'
import { useTasksOptional } from '@/contexts/tasks'
import { extractErrorMessage } from '@/lib/ipc-error'
import { X } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { onProjectUpdated, tasksService, type ProjectRef } from '@/services/tasks-service'

const log = createLogger('EventProjectField')

export interface EventProjectFieldProps {
  mode: 'create' | 'edit'
  /** Saved event id. Required in edit mode; null while drafting a new event. */
  eventId?: string | null
  /** Create mode only: the draft's selected project id. */
  value: string | null
  /** Create mode only: writes the selection back into the draft. */
  onChange: (projectId: string | null) => void
  disabled?: boolean
}

/**
 * Project assignment for a calendar event, backed by `project_links`.
 *
 * Create mode is fully controlled — the selection rides in the draft until the
 * event has an id. Edit mode owns its own state and writes link/unlink
 * immediately, matching the calendar chip's "Add to project" context menu.
 */
export function EventProjectField({
  mode,
  eventId,
  value,
  onChange,
  disabled
}: EventProjectFieldProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const projects = useTasksOptional()?.projects ?? []
  const [links, setLinks] = useState<ProjectRef[]>([])
  // The project this field last picked, keyed by the event it was picked for.
  // `getProjectsForItem` has no ORDER BY, so a reload after a swap can hand
  // back the new link in any position; without this, an event that also
  // carries a legacy second link would show that older link in the picker and
  // demote the just-picked one to a chip. Keying by event id (rather than
  // resetting from an effect) drops the pick as soon as the form switches
  // events, since a different event has a different link set.
  const [chosen, setChosen] = useState<{ eventId: string | null; projectId: string | null }>({
    eventId: eventId ?? null,
    projectId: null
  })
  const chosenId = chosen.eventId === (eventId ?? null) ? chosen.projectId : null
  const isEdit = mode === 'edit'

  // Two separate flags, both gating writes. A single shared flag was
  // reopenable mid-swap: `linkItemToProject`/`unlinkItemFromProject` publish
  // `projectUpdated` before they resolve, so a reload lands between the
  // unlink and the link, and its `finally` would clear the one flag while
  // `links` momentarily reads empty — a click in that window would compute
  // `previousId` as null and link a second project without unlinking. Refs
  // (not state) so the guard is visible synchronously to a call in the same
  // tick, before React re-renders.
  const isLoadingRef = useRef(false)
  const isWritingRef = useRef(false)
  const isBusy = (): boolean => isLoadingRef.current || isWritingRef.current

  const load = useCallback(async (): Promise<void> => {
    if (!isEdit || !eventId) return
    isLoadingRef.current = true
    try {
      const result = await tasksService.listForItem('calendar_event', eventId)
      // `listForItem` runs through the main-side `withDb` wrapper: on a DB
      // error it resolves `{ success: false, error }` instead of rejecting.
      setLinks(Array.isArray(result) ? result : [])
    } catch (error) {
      log.error('Failed to load event projects', extractErrorMessage(error))
      setLinks([])
    } finally {
      isLoadingRef.current = false
    }
  }, [isEdit, eventId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => onProjectUpdated(() => void load()), [load])

  // Shared by `handleSelect` and `handleRemoveExtra`: both are writes on the
  // same `project_links` rows. `isWritingRef` is held across the write *and*
  // its trailing reload, so no interleaved `load()` can open the guard
  // mid-swap. The reload is unconditional so the UI reflects the actual DB
  // state whether the write succeeded or failed.
  const runLinkWrite = async (write: () => Promise<void>): Promise<void> => {
    isWritingRef.current = true
    try {
      await write()
    } catch (error) {
      log.error('Failed to write event project link', {
        eventId,
        error: extractErrorMessage(error)
      })
      toast.error(extractErrorMessage(error, t('form.project-update-failed')))
    } finally {
      await load()
      isWritingRef.current = false
    }
  }

  // `ProjectPicker` filters archived projects out of its list and resolves its
  // trigger only against that filtered list, so a link to an archived project
  // cannot be represented there. Anything it cannot show falls through to the
  // chips below, where it stays visible and removable — and is never the
  // implicit unlink target of the next pick.
  const isPickable = (projectId: string): boolean =>
    projects.some((project) => project.id === projectId && !project.isArchived)

  const primaryLink = links.find((link) => link.id === chosenId) ?? links[0]
  const primaryId = primaryLink && isPickable(primaryLink.id) ? primaryLink.id : null
  const selectedId = isEdit ? primaryId : value
  // Single-select UI over a many-to-many table: every link the picker is not
  // showing keeps its own removable chip. Nothing is dropped that the user did
  // not remove.
  const extraLinks = isEdit ? links.filter((link) => link.id !== primaryId) : []

  const handleSelect = async (nextId: string | null): Promise<void> => {
    if (!isEdit || !eventId) {
      onChange(nextId)
      return
    }
    // External `disabled` (Task 4) and the internal in-flight guard compose
    // here rather than one replacing the other.
    if (disabled || isBusy()) return

    // Only the link the picker is actually showing can be replaced by a pick.
    const previousId = primaryId
    if (previousId === nextId) return

    setChosen({ eventId, projectId: nextId })
    await runLinkWrite(async () => {
      if (previousId) {
        const removed = await tasksService.unlinkProjectItem({
          projectId: previousId,
          itemType: 'calendar_event',
          itemId: eventId
        })
        if (!removed.success) throw new Error(removed.error)
      }
      if (nextId) {
        const added = await tasksService.linkProjectItem({
          projectId: nextId,
          itemType: 'calendar_event',
          itemId: eventId
        })
        if (!added.success) throw new Error(added.error)
      }
    })
  }

  const handleRemoveExtra = async (projectId: string): Promise<void> => {
    if (!eventId) return
    // Same guard as `handleSelect`: a remove is a write on the same
    // `project_links` rows and must not run while another write or load is
    // in flight.
    if (disabled || isBusy()) return

    await runLinkWrite(async () => {
      const removed = await tasksService.unlinkProjectItem({
        projectId,
        itemType: 'calendar_event',
        itemId: eventId
      })
      if (!removed.success) throw new Error(removed.error)
    })
  }

  // Edit mode before the event is saved (canvas cards mount the form without an
  // id): nothing to link to, so render nothing rather than a dead control.
  if (isEdit && !eventId) return null

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{t('form.project')}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <ProjectPicker
          value={selectedId}
          onChange={(next) => void handleSelect(next)}
          projects={projects}
          includeAllOption
          allOptionLabel={t('form.no-project')}
          searchable
          allowCreate={false}
          className="min-w-[160px]"
        />
        {extraLinks.map((project) => (
          <span
            key={project.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: project.color }}
              aria-hidden="true"
            />
            <span className="max-w-32 truncate">{project.name}</span>
            <button
              type="button"
              aria-label={t('form.remove-from-project', { project: project.name })}
              onClick={() => void handleRemoveExtra(project.id)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
    </label>
  )
}

export default EventProjectField
