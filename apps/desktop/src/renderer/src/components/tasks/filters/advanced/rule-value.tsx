import { useState } from 'react'
import type { TaskFilterRule } from '@memry/domain-tasks/filtering'
import { foldTag } from '@memry/shared/tag-fold'
import { useT } from '@memry/i18n/renderer'
import { Picker } from '@/components/ui/picker'
import { priorityConfig, type Priority, type Task } from '@/data/task-model'
import { dueDateFilterLabel, type Project } from '@/data/tasks-data'
import type { TaskNoteIndex } from '@/lib/task-note-index'
import { isValuelessOp } from '@/lib/task-filter-rules'
import { TagPanel } from '../filter-panels/tag-panel'
import { LocationPanel } from '../filter-panels/location-panel'
import { ruleValueLabels } from './rule-labels'

const K = 'filters.advanced'

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low', 'none']
const DUE_VALUES = [
  'overdue',
  'today',
  'tomorrow',
  'this-week',
  'next-week',
  'this-month',
  'none',
  'custom'
] as const

export interface RuleValueContext {
  tasks: Task[]
  projects: Project[]
  noteIndex?: TaskNoteIndex
}

interface RuleValueProps extends RuleValueContext {
  rule: TaskFilterRule
  onChange: (rule: TaskFilterRule) => void
}

const toggle = <T extends string>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value]

/** The value cell of a rule row: its chosen values, and the picker that edits them. */
export function RuleValue({
  rule,
  onChange,
  tasks,
  projects,
  noteIndex
}: RuleValueProps): React.JSX.Element {
  const { t } = useT('tasks')
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  if (isValuelessOp(rule.op)) {
    return <div className="h-[26px] flex-1 rounded-[5px] bg-muted/40" />
  }

  if (rule.field === 'title') {
    return (
      <input
        type="text"
        value={rule.values[0] ?? ''}
        onChange={(e) => onChange({ ...rule, values: [e.target.value] })}
        placeholder={t(`${K}.values.titlePlaceholder`)}
        aria-label={t(`${K}.fields.title`)}
        className="h-[26px] min-w-0 flex-1 rounded-[5px] bg-muted px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
      />
    )
  }

  const labels = ruleValueLabels(rule, { projects, noteIndex, t })
  const trigger = (
    <button
      type="button"
      className="flex min-h-[26px] min-w-0 flex-1 flex-wrap items-center gap-1 rounded-[5px] bg-muted px-1 py-[3px] text-start"
    >
      {labels.length === 0 ? (
        <span className="px-1 text-[12px] text-muted-foreground">{t(`${K}.values.pick`)}</span>
      ) : (
        labels.map((label, i) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- stateless labels; two statuses in different projects can share a name
            key={`${label}-${i}`}
            className="rounded-[4px] border border-border bg-background px-1.5 py-px text-[12px] leading-4 text-foreground"
          >
            {label}
          </span>
        ))
      )}
    </button>
  )

  const close = (): void => setOpen(false)

  if (rule.field === 'tags') {
    return (
      <Picker open={open} onOpenChange={setOpen} closeOnSelect={false}>
        <Picker.Trigger asChild>{trigger}</Picker.Trigger>
        <Picker.Content width={240} align="start">
          <TagPanel
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            selectedTags={rule.values}
            onToggleTag={(tag) => {
              const next = rule.values.some((x) => foldTag(x) === foldTag(tag))
                ? rule.values.filter((x) => foldTag(x) !== foldTag(tag))
                : [...rule.values, tag]
              onChange({ ...rule, values: next })
            }}
            onClose={close}
            onGoBack={close}
            tasks={tasks}
          />
        </Picker.Content>
      </Picker>
    )
  }

  if (rule.field === 'location') {
    return (
      <Picker open={open} onOpenChange={setOpen} closeOnSelect={false}>
        <Picker.Trigger asChild>{trigger}</Picker.Trigger>
        <Picker.Content width={280} align="start">
          <LocationPanel
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            selectedFolderPaths={rule.folderPaths}
            selectedNoteIds={rule.noteIds}
            onToggleFolder={(path) =>
              onChange({ ...rule, folderPaths: toggle(rule.folderPaths, path) })
            }
            onToggleNote={(id) => onChange({ ...rule, noteIds: toggle(rule.noteIds, id) })}
            onGoBack={close}
            tasks={tasks}
            noteIndex={noteIndex}
          />
        </Picker.Content>
      </Picker>
    )
  }

  const single = rule.field === 'repeat' || rule.field === 'hasTime'
  const options = optionsFor(rule, projects, t)
  const selected: string[] =
    rule.field === 'repeat' || rule.field === 'hasTime' ? rule.values.slice(0, 1) : rule.values

  const handleValue = (value: string): void => {
    switch (rule.field) {
      case 'repeat':
        if (value === 'repeating' || value === 'one-time') onChange({ ...rule, values: [value] })
        close()
        return
      case 'hasTime':
        if (value === 'with-time' || value === 'without-time') {
          onChange({ ...rule, values: [value] })
        }
        close()
        return
      case 'priority': {
        const priority = PRIORITIES.find((p) => p === value)
        if (priority) onChange({ ...rule, values: toggle(rule.values, priority) })
        return
      }
      case 'due': {
        const due = DUE_VALUES.find((d) => d === value)
        if (due) onChange({ ...rule, values: toggle(rule.values, due) })
        return
      }
      case 'status':
      case 'project':
        onChange({ ...rule, values: toggle(rule.values, value) })
    }
  }

  return (
    <Picker
      mode={single ? 'single' : 'multi'}
      open={open}
      onOpenChange={setOpen}
      value={single ? (selected[0] ?? null) : selected}
      onValueChange={handleValue}
      closeOnSelect={single}
    >
      <Picker.Trigger asChild>{trigger}</Picker.Trigger>
      <Picker.Content width={240} align="start">
        {options.length > 6 && <Picker.Search placeholder={t(`${K}.values.pick`)} />}
        <Picker.List filterByLabel>
          {options.map((option) =>
            option.section ? (
              <div
                key={option.value}
                className="px-2 pb-0.5 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                {option.label}
              </div>
            ) : (
              <Picker.Item
                key={option.value}
                value={option.value}
                label={option.label}
                indicator={single ? 'check' : 'checkbox'}
                indicatorColor={option.color}
              />
            )
          )}
        </Picker.List>
        {rule.field === 'due' && rule.values.includes('custom') && (
          <Picker.Footer>
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <DateKeyInput
                label={t(`${K}.values.from`)}
                value={rule.dueStart ?? ''}
                onChange={(dueStart) => onChange({ ...rule, dueStart })}
              />
              <span>–</span>
              <DateKeyInput
                label={t(`${K}.values.to`)}
                value={rule.dueEnd ?? ''}
                onChange={(dueEnd) => onChange({ ...rule, dueEnd })}
              />
            </div>
          </Picker.Footer>
        )}
      </Picker.Content>
    </Picker>
  )
}

interface ValueOption {
  value: string
  label: string
  color?: string
  /** A non-selectable heading, for statuses grouped by project. */
  section?: boolean
}

function optionsFor(
  rule: TaskFilterRule,
  projects: readonly Project[],
  t: (key: string) => string
): ValueOption[] {
  switch (rule.field) {
    case 'priority':
      return PRIORITIES.map((p) => ({
        value: p,
        label: priorityConfig[p].label ?? p,
        color: priorityConfig[p].color ?? undefined
      }))
    case 'project':
      return projects
        .filter((p) => !p.isArchived)
        .map((p) => ({ value: p.id, label: p.name, color: p.color }))
    case 'status':
      return projects.flatMap((p) =>
        p.isArchived
          ? []
          : [
              { value: `section:${p.id}`, label: p.name, section: true },
              ...p.statuses.map((s) => ({ value: s.id, label: s.name, color: s.color }))
            ]
      )
    case 'due':
      return DUE_VALUES.map((value) => ({
        value,
        label: value === 'custom' ? t(`${K}.values.customRange`) : dueDateFilterLabel(value)
      }))
    case 'repeat':
      return [
        { value: 'repeating', label: t(`${K}.values.repeating`) },
        { value: 'one-time', label: t(`${K}.values.oneTime`) }
      ]
    case 'hasTime':
      return [
        { value: 'with-time', label: t(`${K}.values.withTime`) },
        { value: 'without-time', label: t(`${K}.values.withoutTime`) }
      ]
    default:
      return []
  }
}

function DateKeyInput({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string | null) => void
}): React.JSX.Element {
  return (
    <input
      type="date"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-6 min-w-0 flex-1 rounded-[4px] border border-border bg-background px-1 text-[12px] text-foreground"
    />
  )
}
