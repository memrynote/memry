import type { Task } from '@/data/task-model'
import type { RelatedRef } from '@/components/tasks/use-related-item-info'
import { DatesChip } from './dates-chip'
import { DescriptionChip } from './description-chip'
import { RelatedChip } from './related-chip'
import { ReminderChip } from './reminder-chip'
import { RepeatChip } from './repeat-chip'
import { TagsChip } from './tags-chip'
import type { OptionalTaskPropertyId, TaskPropertyOpenState } from './task-property-ids'

interface PresenceInput {
  task: Pick<
    Task,
    | 'description'
    | 'isRepeating'
    | 'repeatConfig'
    | 'tags'
    | 'startDate'
    | 'dueDate'
    | 'linkedNoteIds'
    | 'linkedCanvasIds'
  >
  hasActiveReminder: boolean
  hostNoteId: string | null
}

/**
 * What the add menu offers: every optional property the task has no value
 * for, in menu order. A set property is a chip instead, never both.
 */
export const missingTaskProperties = ({
  task,
  hasActiveReminder,
  hostNoteId
}: PresenceInput): OptionalTaskPropertyId[] => {
  const hasRelated =
    task.linkedNoteIds.some((id) => id !== hostNoteId) || (task.linkedCanvasIds?.length ?? 0) > 0
  const missing: [OptionalTaskPropertyId, boolean][] = [
    ['due', !task.dueDate],
    ['start', !task.startDate],
    ['repeat', !(task.isRepeating && task.repeatConfig)],
    ['reminder', !hasActiveReminder],
    ['tags', task.tags.length === 0],
    ['description', !task.description.trim()],
    ['related', !hasRelated]
  ]
  return missing.filter(([, isMissing]) => isMissing).map(([id]) => id)
}

interface TaskBlockPropertiesProps extends TaskPropertyOpenState {
  task: Task
  isCompleted: boolean
  hasActiveReminder: boolean
  hostNoteId: string | null
  projectColor: string
  onUpdate: (updates: Partial<Task>) => void
  onDescriptionChange: (description: string) => void
  onTagsChange: (tags: string[]) => void
  onOpenRelatedItem: (ref: RelatedRef, title: string | null) => void
}

/**
 * The optional half of the row: each property is a chip while it has a value
 * or while its picker is open, and nothing at all otherwise. The permanent
 * half (status, priority, project) stays in TaskRow.
 */
export const TaskBlockProperties = ({
  task,
  isCompleted,
  hasActiveReminder,
  hostNoteId,
  projectColor,
  onUpdate,
  onDescriptionChange,
  onTagsChange,
  onOpenRelatedItem,
  open,
  onOpenChange
}: TaskBlockPropertiesProps): React.JSX.Element => {
  const openState = { open, onOpenChange }
  return (
    <div className="flex min-w-0 shrink items-center gap-1 overflow-x-clip py-0.5">
      <DescriptionChip
        taskId={task.id}
        description={task.description}
        onChange={onDescriptionChange}
        {...openState}
      />
      <RepeatChip
        taskTitle={task.title}
        repeatConfig={task.repeatConfig}
        isRepeating={task.isRepeating}
        dueDate={task.dueDate}
        onChange={onUpdate}
        {...openState}
      />
      <TagsChip tags={task.tags} onChange={onTagsChange} {...openState} />
      <DatesChip
        startDate={task.startDate ?? null}
        dueDate={task.dueDate}
        dueTime={task.dueTime}
        isCompleted={isCompleted}
        onChange={onUpdate}
        {...openState}
      />
      <ReminderChip taskId={task.id} hasActiveReminder={hasActiveReminder} {...openState} />
      <RelatedChip
        linkedNoteIds={task.linkedNoteIds}
        linkedCanvasIds={task.linkedCanvasIds ?? []}
        hostNoteId={hostNoteId}
        projectColor={projectColor}
        onChange={onUpdate}
        onOpenItem={onOpenRelatedItem}
        {...openState}
      />
    </div>
  )
}
