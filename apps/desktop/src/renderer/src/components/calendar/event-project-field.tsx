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
  const isEdit = mode === 'edit'

  // Guards two races around the single "current link" truth held in `links`:
  // a selection fired before the initial `load()` resolves would read
  // `previousId` from the still-empty state and skip the unlink it owes; a
  // second selection fired before the first write's trailing `load()`
  // resolves would read that same stale state and skip its unlink too. Both
  // would leave the event linked to two projects behind a UI that shows only
  // one. A ref (not state) is required so the guard is visible synchronously
  // to a call in the same tick, before React re-renders. `load()` holds this
  // flag for its own duration too, so the initial mount load and any
  // `onProjectUpdated`-triggered reload gate selections the same way.
  const pendingRef = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (!isEdit || !eventId) return
    pendingRef.current = true
    try {
      const result = await tasksService.listForItem('calendar_event', eventId)
      // `listForItem` runs through the main-side `withDb` wrapper: on a DB
      // error it resolves `{ success: false, error }` instead of rejecting.
      setLinks(Array.isArray(result) ? result : [])
    } catch (error) {
      log.error('Failed to load event projects', extractErrorMessage(error))
      setLinks([])
    } finally {
      pendingRef.current = false
    }
  }, [isEdit, eventId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => onProjectUpdated(() => void load()), [load])

  // Shared by `handleSelect` and `handleRemoveExtra`: both are writes on the
  // same `project_links` rows and must hold `pendingRef` for their duration,
  // then unconditionally reload (which clears `pendingRef` in its own
  // `finally`) so the UI reflects the actual DB state whether the write
  // succeeded or failed.
  const runLinkWrite = async (write: () => Promise<void>): Promise<void> => {
    pendingRef.current = true
    try {
      await write()
    } catch (error) {
      toast.error(extractErrorMessage(error, t('form.project-update-failed')))
    }
    await load()
  }

  const handleSelect = async (nextId: string | null): Promise<void> => {
    if (!isEdit || !eventId) {
      onChange(nextId)
      return
    }
    // External `disabled` (Task 4) and the internal in-flight guard compose
    // here rather than one replacing the other.
    if (disabled || pendingRef.current) return

    const previousId = links[0]?.id ?? null
    if (previousId === nextId) return

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
    if (disabled || pendingRef.current) return

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

  const selectedId = isEdit ? (links[0]?.id ?? null) : value
  // Single-select UI over a many-to-many table: an event linked to several
  // projects (possible via the chip context menu) keeps every link visible and
  // individually removable. Nothing is dropped that the user did not remove.
  const extraLinks = isEdit ? links.slice(1) : []

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
