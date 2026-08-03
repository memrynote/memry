import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

import { ProjectPicker } from '@/components/tasks/project-picker'
import { useTasksOptional } from '@/contexts/tasks'
import { extractErrorMessage } from '@/lib/ipc-error'
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
  onChange
}: EventProjectFieldProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const projects = useTasksOptional()?.projects ?? []
  const [links, setLinks] = useState<ProjectRef[]>([])
  const isEdit = mode === 'edit'

  const load = useCallback(async (): Promise<void> => {
    if (!isEdit || !eventId) return
    try {
      const result = await tasksService.listForItem('calendar_event', eventId)
      // `listForItem` runs through the main-side `withDb` wrapper: on a DB
      // error it resolves `{ success: false, error }` instead of rejecting.
      setLinks(Array.isArray(result) ? result : [])
    } catch (error) {
      log.error('Failed to load event projects', extractErrorMessage(error))
      setLinks([])
    }
  }, [isEdit, eventId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => onProjectUpdated(() => void load()), [load])

  const handleSelect = async (nextId: string | null): Promise<void> => {
    if (!isEdit || !eventId) {
      onChange(nextId)
      return
    }
    const previousId = links[0]?.id ?? null
    if (previousId === nextId) return

    try {
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
    } catch (error) {
      toast.error(extractErrorMessage(error, t('form.project-update-failed')))
    }
    await load()
  }

  // Edit mode before the event is saved (canvas cards mount the form without an
  // id): nothing to link to, so render nothing rather than a dead control.
  if (isEdit && !eventId) return null

  const selectedId = isEdit ? (links[0]?.id ?? null) : value

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
      </div>
    </label>
  )
}

export default EventProjectField
