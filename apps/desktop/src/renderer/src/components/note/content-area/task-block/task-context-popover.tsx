import { useCallback, useMemo, useState } from 'react'

import { CalendarClock, ChevronRight, Hash, SlidersHorizontal } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { CheckMark } from '@/components/ui/check-mark'
import { FilterSearchHeader } from '@/components/ui/filter-search-header'
import { Picker, usePickerContext } from '@/components/ui/picker'
import { StatusDot } from '@/components/ui/status-dot'
import { DatePickerContent } from '@/components/tasks/date-picker-content'
import { BackButton } from '@/components/tasks/filters/filter-panels/priority-panel'
import { ProjectIcon } from '@/components/tasks/project-icon'
import { PriorityIcon } from '@/components/tasks/task-icons'
import { getTagColors } from '@/components/note/tags-row'
import { useNoteTagsQuery } from '@/hooks/use-notes-query'
import { formatDateShort } from '@/lib/task-utils'
import { priorityConfig, type Priority, type Task as DisplayTask } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { useT } from '@memry/i18n/renderer'

const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

type PanelId = 'priority' | 'dueDate' | 'tags' | 'project'

interface TaskContextPopoverProps {
  task: DisplayTask
  projects: Project[]
  onUpdate: (updates: Partial<DisplayTask>) => void
  onProjectChange: (projectId: string) => void
}

/**
 * The inline task's metadata editor (#2241). Everything the journal user could
 * previously only reach by navigating to the task page — priority, due date,
 * tags, project — behind one hover affordance, so the row itself stays a row.
 *
 * Panels swap inside a single popover rather than opening nested ones: a
 * Radix popover inside a Radix popover fights over dismissal, and the flat
 * menu→panel shape is the one `filter-dropdown` already established.
 */
export const TaskContextPopover = ({
  task,
  projects,
  onUpdate,
  onProjectChange
}: TaskContextPopoverProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const [open, setOpen] = useState(false)

  return (
    <Picker open={open} onOpenChange={setOpen} closeOnSelect={false}>
      <Picker.Trigger asChild>
        <button
          type="button"
          className={cn(
            'shrink-0 rounded p-0.5 transition-opacity hover:bg-accent/80',
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          )}
          aria-label={t('inlineContext.trigger')}
          title={t('inlineContext.trigger')}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <SlidersHorizontal className="size-3 text-muted-foreground" />
        </button>
      </Picker.Trigger>
      <Picker.Content width={240} align="end" sideOffset={6}>
        <TaskContextPanels
          task={task}
          projects={projects}
          onUpdate={onUpdate}
          onProjectChange={onProjectChange}
        />
      </Picker.Content>
    </Picker>
  )
}

/**
 * Split from the trigger so it can read the picker's `activePanel` — the panel
 * state lives in `Picker`'s own context, which only exists below the root.
 */
const TaskContextPanels = ({
  task,
  projects,
  onUpdate,
  onProjectChange
}: TaskContextPopoverProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const { onPanelChange } = usePickerContext()
  const goBack = useCallback(() => onPanelChange(null), [onPanelChange])

  const project = projects.find((p) => p.id === task.projectId)
  const priorityLabel =
    task.priority === 'none'
      ? t('inlineContext.none')
      : (priorityConfig[task.priority].label ?? task.priority)

  const rows: { id: PanelId; icon: React.ReactNode; label: string; value: string }[] = [
    {
      id: 'priority',
      icon: <PriorityIcon priority={task.priority} className="text-text-tertiary" />,
      label: t('task.priority'),
      value: priorityLabel
    },
    {
      id: 'dueDate',
      icon: <CalendarClock size={13} className="text-text-tertiary" />,
      label: t('inlineContext.dueDate'),
      value: task.dueDate ? formatDateShort(task.dueDate) : t('inlineContext.none')
    },
    {
      id: 'tags',
      icon: <Hash size={13} className="text-text-tertiary" />,
      label: t('task.tags'),
      value: task.tags.length > 0 ? task.tags.join(', ') : t('inlineContext.none')
    },
    {
      id: 'project',
      icon: <StatusDot color={project?.color ?? 'var(--text-tertiary)'} />,
      label: t('task.project'),
      value: project?.name ?? t('inlineContext.none')
    }
  ]

  return (
    <>
      <Picker.Panel id={null}>
        <Picker.List>
          {rows.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onPanelChange(row.id)}
              className="flex items-center rounded-[5px] py-1.5 px-2 gap-2 hover:bg-accent transition-colors"
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">{row.icon}</span>
              <span className="text-muted-foreground">{row.label}</span>
              <span className="ms-auto max-w-[110px] truncate text-[11px] text-text-tertiary leading-3.5">
                {row.value}
              </span>
              <ChevronRight size={10} className="shrink-0 text-muted-foreground/60" />
            </button>
          ))}
        </Picker.List>
      </Picker.Panel>

      <Picker.Panel id="priority">
        <PanelHeader label={t('task.priority')} onGoBack={goBack} />
        <Picker.List>
          {PRIORITY_ORDER.map((value) => (
            <PanelRow
              key={value}
              selected={task.priority === value}
              onSelect={() => {
                onUpdate({ priority: value })
                goBack()
              }}
              icon={
                <PriorityIcon
                  priority={value}
                  className={cn(value === 'none' && 'text-text-tertiary')}
                />
              }
              label={
                value === 'none' ? t('inlineContext.none') : (priorityConfig[value].label ?? value)
              }
            />
          ))}
        </Picker.List>
      </Picker.Panel>

      <Picker.Panel id="dueDate">
        <PanelHeader label={t('inlineContext.dueDate')} onGoBack={goBack} />
        <DatePickerContent
          selected={task.dueDate}
          time={task.dueTime}
          onSelect={(date) => {
            onUpdate({ dueDate: date, ...(date ? {} : { dueTime: null }) })
            goBack()
          }}
          onTimeChange={(time) => onUpdate({ dueTime: time })}
        />
      </Picker.Panel>

      <Picker.Panel id="tags">
        <TagPanel task={task} onUpdate={onUpdate} onGoBack={goBack} />
      </Picker.Panel>

      <Picker.Panel id="project">
        <PanelHeader label={t('task.project')} onGoBack={goBack} />
        <Picker.List className="max-h-56">
          {projects.map((p) => (
            <PanelRow
              key={p.id}
              selected={p.id === task.projectId}
              onSelect={() => {
                onProjectChange(p.id)
                goBack()
              }}
              icon={
                <ProjectIcon
                  icon={p.icon}
                  className="size-3.5"
                  color={p.color}
                  fallback={<StatusDot color={p.color} />}
                />
              }
              label={p.name}
            />
          ))}
        </Picker.List>
      </Picker.Panel>
    </>
  )
}

const PanelHeader = ({
  label,
  onGoBack
}: {
  label: string
  onGoBack: () => void
}): React.JSX.Element => (
  <div className="flex items-center py-2 px-3 gap-1.5 border-b border-border">
    <BackButton onClick={onGoBack} />
    <span className="text-[13px] text-foreground font-medium leading-4">{label}</span>
  </div>
)

const PanelRow = ({
  selected,
  onSelect,
  icon,
  label
}: {
  selected: boolean
  onSelect: () => void
  icon: React.ReactNode
  label: string
}): React.JSX.Element => (
  <button
    type="button"
    onClick={onSelect}
    className={cn(
      'flex items-center rounded-[5px] py-1.5 px-2 gap-2 transition-colors',
      selected ? 'bg-accent' : 'hover:bg-accent'
    )}
  >
    <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
    <span
      className={cn(
        'truncate text-[13px] leading-4',
        selected ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {label}
    </span>
    {selected && <CheckMark className="ms-auto text-foreground" />}
  </button>
)

/**
 * Multi-select, so it stays open across several toggles and only leaves on the
 * back button. A query with no match offers to create the tag: the task tag
 * pool is free text, and forcing a trip to a tag manager to name one would put
 * the navigation back that this popover exists to remove.
 */
const TagPanel = ({
  task,
  onUpdate,
  onGoBack
}: {
  task: DisplayTask
  onUpdate: (updates: Partial<DisplayTask>) => void
  onGoBack: () => void
}): React.JSX.Element => {
  const { t } = useT('tasks')
  const [query, setQuery] = useState('')
  const { tags: tagDefs } = useNoteTagsQuery()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? tagDefs.filter((def) => def.tag.toLowerCase().includes(q)) : tagDefs
  }, [tagDefs, query])

  const trimmedQuery = query.trim()
  const canCreate =
    trimmedQuery.length > 0 &&
    !tagDefs.some((def) => def.tag.toLowerCase() === trimmedQuery.toLowerCase())

  const toggle = useCallback(
    (tag: string) => {
      const has = task.tags.some((x) => x.toLowerCase() === tag.toLowerCase())
      onUpdate({
        tags: has
          ? task.tags.filter((x) => x.toLowerCase() !== tag.toLowerCase())
          : [...task.tags, tag]
      })
    },
    [task.tags, onUpdate]
  )

  return (
    <>
      <PanelHeader label={t('task.tags')} onGoBack={onGoBack} />
      <FilterSearchHeader
        value={query}
        onChange={setQuery}
        placeholder={t('inlineContext.searchTags')}
        className="py-1.5"
      />
      <Picker.List className="max-h-56">
        {canCreate && (
          <PanelRow
            selected={false}
            onSelect={() => {
              toggle(trimmedQuery)
              setQuery('')
            }}
            icon={<Hash size={13} className="text-text-tertiary" />}
            label={t('inlineContext.createTag', { name: trimmedQuery })}
          />
        )}
        {filtered.map((def) => (
          <PanelRow
            key={def.tag}
            selected={task.tags.some((x) => x.toLowerCase() === def.tag.toLowerCase())}
            onSelect={() => toggle(def.tag)}
            icon={<StatusDot color={getTagColors(def.color, def.tag).text} />}
            label={def.tag}
          />
        ))}
      </Picker.List>
    </>
  )
}
