import { useT } from '@memry/i18n/renderer'

import { ProjectPicker } from '@/components/tasks/project-picker'
import { useTasksOptional } from '@/contexts/tasks'

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
  value,
  onChange,
  disabled
}: EventProjectFieldProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const projects = useTasksOptional()?.projects ?? []

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{t('form.project')}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <ProjectPicker
          value={value}
          onChange={onChange}
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
