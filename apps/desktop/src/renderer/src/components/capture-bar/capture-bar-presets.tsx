/**
 * The presets chip inside the Tasks capture bar.
 *
 * `[Today | v]` sits at the end of the focused bar. The date half opens the
 * same DatePickerContent the task drawer uses; the chevron opens a menu that
 * can set every other property the task will be created with. Anything set to a
 * non-default value shows as its own chip to the left, so the bar always shows
 * what Enter will save.
 *
 * Every editor here is one that already exists elsewhere in the app. State is
 * owned by CaptureBar; this component only renders it and reports changes.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ArrowUpRight,
  Bell,
  Calendar,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Hash,
  Link2,
  Repeat,
  X
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import { isMac } from '@/lib/shortcut-registry'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { DatePickerContent } from '@/components/tasks/date-picker-content'
import { PriorityIcon } from '@/components/tasks/task-icons'
import { ProjectIcon } from '@/components/tasks/project-icon'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { standardPresets, formatReminderDate } from '@/components/reminder/reminder-presets'
import { formatDateShort, formatDueDate, formatTime, getDefaultTodoStatus } from '@/lib/task-utils'
import { getRepeatDisplayText, getRepeatPresets } from '@/lib/repeat-utils'
import { priorityConfig, type Priority } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import type { MergedPresets, TaskPresets } from './capture-presets'

export type PresetsMenuView =
  'root' | 'project' | 'status' | 'startDate' | 'repeat' | 'reminder' | 'tags'

/** Which surface is open: the date picker, a menu view, or nothing. */
export type PresetsPanel = 'date' | PresetsMenuView

/** Order and 1–5 shortcuts match the inline priority popover on task rows. */
const PRIORITY_ORDER: Priority[] = ['urgent', 'high', 'medium', 'low', 'none']

const DUE_TONE: Record<string, string> = {
  overdue: 'text-task-due-overdue',
  today: 'text-task-due-today',
  tomorrow: 'text-task-due-tomorrow'
}

const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement

/** Keeps the capture field focused when a chip is pressed. */
const keepFieldFocus = (e: React.MouseEvent): void => e.preventDefault()

export interface CapturePresetsProps {
  presets: TaskPresets
  /** Presets with the typed tokens laid over them — what Enter will save. */
  merged: MergedPresets
  /** Fields a typed token currently decides; their preset chip is hidden. */
  overriddenByText: { priority: boolean; projectId: boolean; repeat: boolean }
  projects: Project[]
  /** The project the surface files into when none is picked. */
  defaultProjectId: string | null
  /** Show the `[date | v]` chip (the bar is focused or a panel is open). */
  showDateChip: boolean
  panel: PresetsPanel | null
  onPanelChange: (panel: PresetsPanel | null) => void
  onChange: (patch: Partial<TaskPresets>) => void
  onLinkNote: () => void
  onOpenDetail?: () => void
  /** Called when a panel closes, so focus lands back in the text. */
  onReturnFocus: () => void
}

// ----------------------------------------------------------------------------
// Rows
// ----------------------------------------------------------------------------

interface MenuRowProps {
  icon?: React.ReactNode
  label: string
  value?: string
  /** Opens this submenu. */
  view?: PresetsMenuView
  selected?: boolean
  destructive?: boolean
  trailing?: React.ReactNode
  onSelect: () => void
}

const MenuRow = ({
  icon,
  label,
  value,
  view,
  selected,
  destructive,
  trailing,
  onSelect
}: MenuRowProps): React.JSX.Element => (
  <button
    type="button"
    data-preset-item=""
    data-preset-view={view}
    onClick={onSelect}
    className={cn(
      'flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-start text-[12px] leading-4',
      'outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
      selected && 'bg-accent/60'
    )}
  >
    {icon !== undefined && (
      <span className="flex size-4 shrink-0 items-center justify-center text-text-tertiary">
        {icon}
      </span>
    )}
    <span
      className={cn(
        'min-w-0 flex-1 truncate',
        destructive ? 'text-destructive' : 'text-foreground'
      )}
    >
      {label}
    </span>
    {value && (
      <span className="max-w-[120px] shrink-0 truncate text-[11px] text-text-tertiary">
        {value}
      </span>
    )}
    {trailing}
    {view && <ChevronRight className="size-3 shrink-0 text-text-tertiary rtl:rotate-180" />}
    {selected && !view && <Check className="size-3 shrink-0 text-text-secondary" />}
  </button>
)

// ----------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------

export const CapturePresets = ({
  presets,
  merged,
  overriddenByText,
  projects,
  defaultProjectId,
  showDateChip,
  panel,
  onPanelChange,
  onChange,
  onLinkNote,
  onOpenDetail,
  onReturnFocus
}: CapturePresetsProps): React.JSX.Element | null => {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const anchorRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const activeProjects = useMemo(() => projects.filter((p) => !p.isArchived), [projects])
  const effectiveProject = useMemo(
    () => projects.find((p) => p.id === (merged.projectId ?? defaultProjectId)) ?? null,
    [projects, merged.projectId, defaultProjectId]
  )
  const pickedProject = useMemo(
    () => (presets.projectId ? (projects.find((p) => p.id === presets.projectId) ?? null) : null),
    [projects, presets.projectId]
  )
  const statuses = useMemo(
    () => [...(effectiveProject?.statuses ?? [])].sort((a, b) => a.order - b.order),
    [effectiveProject]
  )
  const pickedStatus = statuses.find((s) => s.id === merged.statusId) ?? null
  const defaultStatus = effectiveProject ? getDefaultTodoStatus(effectiveProject) : null
  const repeatPresets = useMemo(() => getRepeatPresets(merged.dueDate), [merged.dueDate])

  const dueLabel = useMemo(() => {
    if (!merged.dueDate) return t('quickAdd.presets.noDate')
    const day = formatDueDate(merged.dueDate, null)?.label ?? formatDateShort(merged.dueDate)
    return merged.dueTime ? `${day} ${formatTime(merged.dueTime, clockFormat)}` : day
  }, [merged.dueDate, merged.dueTime, clockFormat, t])
  const dueTone = merged.dueDate
    ? (DUE_TONE[formatDueDate(merged.dueDate, null)?.status ?? ''] ?? 'text-foreground/80')
    : 'text-text-tertiary'

  const view: PresetsMenuView | null = panel && panel !== 'date' ? panel : null

  // Every view change lands focus on its first control, so the keyboard never
  // has to hunt for where the menu went.
  useEffect(() => {
    if (!panel) return
    const frame = requestAnimationFrame(() => {
      const root = contentRef.current
      if (!root) return
      // The tag view's input focuses itself.
      if (root.contains(document.activeElement) && isTextEntry(document.activeElement)) return
      const target =
        root.querySelector<HTMLElement>('[data-preset-item]') ??
        root.querySelector<HTMLElement>('button')
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [panel])

  const close = useCallback((): void => onPanelChange(null), [onPanelChange])
  const back = useCallback((): void => onPanelChange('root'), [onPanelChange])

  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (isTextEntry(e.target)) return

      if (view === 'root') {
        const index = Number(e.key) - 1
        if (index >= 0 && index < PRIORITY_ORDER.length) {
          e.preventDefault()
          onChange({ priority: PRIORITY_ORDER[index] })
          return
        }
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(
          contentRef.current?.querySelectorAll<HTMLElement>('[data-preset-item]') ?? []
        )
        if (items.length === 0) return
        e.preventDefault()
        const current = items.indexOf(document.activeElement as HTMLElement)
        const step = e.key === 'ArrowDown' ? 1 : -1
        const next = current === -1 ? 0 : (current + step + items.length) % items.length
        items[next].focus()
        return
      }

      if (e.key === 'ArrowRight' && view === 'root') {
        const target = (document.activeElement as HTMLElement | null)?.dataset.presetView
        if (target) {
          e.preventDefault()
          onPanelChange(target as PresetsMenuView)
        }
        return
      }

      if (e.key === 'ArrowLeft' && view && view !== 'root') {
        e.preventDefault()
        back()
      }
    },
    [view, onChange, onPanelChange, back]
  )

  // --------------------------------------------------------------------------
  // Preset chips (left of the date chip)
  // --------------------------------------------------------------------------

  const chips: {
    key: string
    view: PresetsMenuView
    icon: React.ReactNode
    label: string
    clear: Partial<TaskPresets>
  }[] = []
  if (presets.priority !== 'none' && !overriddenByText.priority) {
    chips.push({
      key: 'priority',
      view: 'root',
      icon: <PriorityIcon priority={presets.priority} className="size-3" />,
      label: priorityConfig[presets.priority].label ?? presets.priority,
      clear: { priority: 'none' }
    })
  }
  if (pickedProject && !overriddenByText.projectId) {
    chips.push({
      key: 'project',
      view: 'project',
      icon: (
        <span
          className="size-2 rounded-[2px]"
          style={{ backgroundColor: pickedProject.color }}
          aria-hidden="true"
        />
      ),
      label: pickedProject.name,
      clear: { projectId: null, statusId: null }
    })
  }
  if (pickedStatus && merged.statusId) {
    chips.push({
      key: 'status',
      view: 'status',
      icon: <Circle className="size-3" style={{ color: pickedStatus.color }} />,
      label: pickedStatus.name,
      clear: { statusId: null }
    })
  }
  if (presets.startDate) {
    chips.push({
      key: 'startDate',
      view: 'startDate',
      icon: <CalendarClock className="size-3" />,
      label: formatDateShort(presets.startDate),
      clear: { startDate: null }
    })
  }
  if (presets.repeat && !overriddenByText.repeat) {
    chips.push({
      key: 'repeat',
      view: 'repeat',
      icon: <Repeat className="size-3" />,
      label: getRepeatDisplayText(presets.repeat, tCommon),
      clear: { repeat: null }
    })
  }
  if (presets.reminderAt) {
    chips.push({
      key: 'reminder',
      view: 'reminder',
      icon: <Bell className="size-3" />,
      label: formatReminderDate(presets.reminderAt, clockFormat, true),
      clear: { reminderAt: null }
    })
  }
  if (presets.tags.length > 0) {
    chips.push({
      key: 'tags',
      view: 'tags',
      icon: <Hash className="size-3" />,
      label: presets.tags.join(', '),
      clear: { tags: [] }
    })
  }

  if (!showDateChip && chips.length === 0) return null

  // --------------------------------------------------------------------------
  // Menu views
  // --------------------------------------------------------------------------

  const subHeader = (title: string): React.JSX.Element => (
    <div className="flex items-center gap-1 border-b border-border px-1 pb-1 mb-1">
      <button
        type="button"
        onClick={back}
        aria-label={t('quickAdd.presets.back')}
        className="flex size-6 items-center justify-center rounded-[5px] text-text-tertiary outline-none hover:bg-accent focus-visible:bg-accent"
      >
        <ChevronLeft className="size-3.5 rtl:rotate-180" />
      </button>
      <span className="text-[12px] font-medium text-foreground">{title}</span>
    </div>
  )

  const renderView = (): React.JSX.Element | null => {
    switch (view) {
      case 'root':
        return (
          <div className="flex flex-col">
            <div className="px-2 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
              {t('task.priority')}
            </div>
            <div role="group" aria-label={t('task.priority')} className="flex gap-1 px-1 pb-1.5">
              {PRIORITY_ORDER.map((priority, index) => {
                const active = merged.priority === priority
                const label = priorityConfig[priority].label ?? priority
                return (
                  <button
                    key={priority}
                    type="button"
                    data-preset-item=""
                    aria-pressed={active}
                    aria-label={`${label} (${index + 1})`}
                    title={`${label}  ${index + 1}`}
                    onClick={() => onChange({ priority })}
                    className={cn(
                      'flex h-7 flex-1 items-center justify-center rounded-[5px] outline-none transition-colors',
                      'hover:bg-accent focus-visible:bg-accent',
                      active && 'bg-accent ring-1 ring-inset ring-border'
                    )}
                  >
                    <PriorityIcon
                      priority={priority}
                      className={cn(priority === 'none' && 'text-text-tertiary')}
                    />
                  </button>
                )
              })}
            </div>
            <div className="mx-1 mb-1 h-px bg-border" />
            <MenuRow
              view="project"
              icon={
                effectiveProject ? (
                  <ProjectIcon
                    icon={effectiveProject.icon}
                    className="size-3.5"
                    color={effectiveProject.color}
                    fallback={
                      <span
                        className="size-2 rounded-[2px]"
                        style={{ backgroundColor: effectiveProject.color }}
                      />
                    }
                  />
                ) : undefined
              }
              label={t('task.project')}
              value={effectiveProject?.name}
              onSelect={() => onPanelChange('project')}
            />
            <MenuRow
              view="status"
              icon={
                <Circle
                  className="size-3"
                  style={{ color: (pickedStatus ?? defaultStatus)?.color }}
                />
              }
              label={t('task.status')}
              value={(pickedStatus ?? defaultStatus)?.name}
              onSelect={() => onPanelChange('status')}
            />
            <MenuRow
              view="startDate"
              icon={<CalendarClock className="size-3.5" />}
              label={t('task.startDate')}
              value={presets.startDate ? formatDateShort(presets.startDate) : undefined}
              onSelect={() => onPanelChange('startDate')}
            />
            <MenuRow
              view="repeat"
              icon={<Repeat className="size-3.5" />}
              label={t('task.repeat')}
              value={merged.repeat ? getRepeatDisplayText(merged.repeat, tCommon) : undefined}
              onSelect={() => onPanelChange('repeat')}
            />
            <MenuRow
              view="reminder"
              icon={<Bell className="size-3.5" />}
              label={t('task.reminder')}
              value={
                presets.reminderAt
                  ? formatReminderDate(presets.reminderAt, clockFormat, true)
                  : undefined
              }
              onSelect={() => onPanelChange('reminder')}
            />
            <MenuRow
              view="tags"
              icon={<Hash className="size-3.5" />}
              label={t('task.tags')}
              value={presets.tags.length > 0 ? presets.tags.join(', ') : undefined}
              onSelect={() => onPanelChange('tags')}
            />
            <MenuRow
              icon={<Link2 className="size-3.5" />}
              label={t('quickAdd.presets.linkNote')}
              trailing={
                <span className="font-[family-name:var(--font-mono)] text-[10px] text-text-tertiary">
                  [[
                </span>
              }
              onSelect={onLinkNote}
            />
            {onOpenDetail && (
              <>
                <div className="mx-1 my-1 h-px bg-border" />
                <MenuRow
                  icon={<ArrowUpRight className="size-3.5" />}
                  label={t('quickAdd.presets.openDetails')}
                  trailing={
                    <span className="rounded-[3px] border border-border bg-foreground/5 px-1 font-[family-name:var(--font-mono)] text-[9px] font-medium leading-3 text-text-tertiary">
                      {isMac ? '⌘' : 'Ctrl'} ↵
                    </span>
                  }
                  onSelect={onOpenDetail}
                />
              </>
            )}
          </div>
        )

      case 'project':
        return (
          <div className="flex flex-col">
            {subHeader(t('task.project'))}
            <div className="max-h-64 overflow-y-auto">
              {activeProjects.map((project) => (
                <MenuRow
                  key={project.id}
                  icon={
                    <ProjectIcon
                      icon={project.icon}
                      className="size-3.5"
                      color={project.color}
                      fallback={
                        <span
                          className="size-2 rounded-[2px]"
                          style={{ backgroundColor: project.color }}
                        />
                      }
                    />
                  }
                  label={project.name}
                  selected={effectiveProject?.id === project.id}
                  onSelect={() => {
                    onChange({ projectId: project.id, statusId: null })
                    back()
                  }}
                />
              ))}
            </div>
          </div>
        )

      case 'status':
        return (
          <div className="flex flex-col">
            {subHeader(t('task.status'))}
            {statuses.map((status) => (
              <MenuRow
                key={status.id}
                icon={<Circle className="size-3" style={{ color: status.color }} />}
                label={status.name}
                selected={(pickedStatus ?? defaultStatus)?.id === status.id}
                onSelect={() => {
                  onChange({ statusId: status.id })
                  back()
                }}
              />
            ))}
          </div>
        )

      case 'startDate':
        return (
          <div className="flex min-h-0 flex-col">
            {subHeader(t('task.startDate'))}
            <DatePickerContent
              selected={presets.startDate}
              showRemoveDate={Boolean(presets.startDate)}
              onSelect={(date) => {
                onChange({ startDate: date })
                back()
              }}
            />
          </div>
        )

      case 'repeat':
        return (
          <div className="flex flex-col">
            {subHeader(t('task.repeat'))}
            <MenuRow
              label={t('phaseF.componentsTasksRepeatPicker.doesNotRepeat')}
              selected={!merged.repeat}
              onSelect={() => {
                onChange({ repeat: null })
                back()
              }}
            />
            <div className="mx-1 my-1 h-px bg-border" />
            {repeatPresets.map((preset) => (
              <MenuRow
                key={preset.id}
                label={preset.label}
                selected={
                  merged.repeat !== null &&
                  getRepeatDisplayText(merged.repeat, tCommon) ===
                    getRepeatDisplayText(preset.config, tCommon)
                }
                onSelect={() => {
                  onChange({ repeat: preset.config })
                  back()
                }}
              />
            ))}
          </div>
        )

      case 'reminder':
        return (
          <div className="flex flex-col">
            {subHeader(t('task.reminder'))}
            {standardPresets.map((preset) => (
              <MenuRow
                key={preset.id}
                label={preset.label}
                value={formatReminderDate(preset.getDate(), clockFormat, true)}
                onSelect={() => {
                  onChange({ reminderAt: preset.getDate() })
                  back()
                }}
              />
            ))}
            {presets.reminderAt && (
              <>
                <div className="mx-1 my-1 h-px bg-border" />
                <MenuRow
                  label={t('quickAdd.presets.noReminder')}
                  destructive
                  onSelect={() => {
                    onChange({ reminderAt: null })
                    back()
                  }}
                />
              </>
            )}
          </div>
        )

      case 'tags':
        return (
          <div className="flex flex-col">
            {subHeader(t('task.tags'))}
            {/* The tag input handles its own keys; stop them reaching the
                menu's arrow navigation. Escape still closes the panel. */}
            <div
              className="px-1 pb-1"
              onKeyDown={(e) => {
                if (e.key !== 'Escape') e.stopPropagation()
              }}
            >
              <TagAutocomplete
                tags={presets.tags}
                onTagsChange={(tags) => onChange({ tags })}
                placeholder={t('quickAdd.presets.addTags')}
                autoFocus
              />
            </div>
          </div>
        )

      default:
        return null
    }
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <Popover
      open={panel !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <div className="flex shrink-0 items-center gap-1">
        {chips.map((chip) => (
          <span
            key={chip.key}
            className="group/chip inline-flex h-5 max-w-[140px] items-center rounded-[5px] border border-border bg-background text-[11px] leading-4 text-text-secondary"
          >
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={keepFieldFocus}
              onClick={() => onPanelChange(chip.view)}
              className="flex min-w-0 items-center gap-1 ps-1.5 pe-1.5 group-hover/chip:pe-0.5"
            >
              <span className="flex shrink-0 items-center">{chip.icon}</span>
              <span className="truncate">{chip.label}</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={keepFieldFocus}
              onClick={() => onChange(chip.clear)}
              aria-label={t('quickAdd.presets.remove', { name: chip.label })}
              className="hidden pe-1 text-text-tertiary hover:text-foreground group-hover/chip:flex"
            >
              <X className="size-2.5" />
            </button>
          </span>
        ))}

        {showDateChip && (
          <PopoverAnchor asChild>
            <div
              ref={anchorRef}
              className="inline-flex h-5 items-stretch rounded-[5px] border border-border bg-background text-[11px] leading-4"
            >
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={keepFieldFocus}
                onClick={() => onPanelChange(panel === 'date' ? null : 'date')}
                aria-label={t('quickAdd.presets.dueDate', { date: dueLabel })}
                aria-expanded={panel === 'date'}
                className={cn(
                  'flex items-center gap-1 rounded-s-[4px] ps-1.5 pe-1.5 transition-colors hover:bg-accent',
                  panel === 'date' && 'bg-accent',
                  dueTone
                )}
              >
                <Calendar size={11} className="shrink-0" />
                <span className="whitespace-nowrap font-medium">{dueLabel}</span>
              </button>
              <span className="w-px bg-border" aria-hidden="true" />
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={keepFieldFocus}
                onClick={() => onPanelChange(view ? null : 'root')}
                aria-label={t('quickAdd.presets.menu')}
                aria-haspopup="menu"
                aria-expanded={view !== null}
                className={cn(
                  'flex items-center rounded-e-[4px] px-1 text-text-tertiary transition-colors hover:bg-accent hover:text-foreground',
                  view && 'bg-accent text-foreground'
                )}
              >
                <ChevronDown className="size-3" />
              </button>
            </div>
          </PopoverAnchor>
        )}
      </div>

      <PopoverContent
        ref={contentRef}
        align="end"
        sideOffset={6}
        className={cn(
          'flex max-h-(--radix-popover-content-available-height) flex-col overflow-clip p-0',
          panel === 'date' ? 'w-auto' : 'w-[260px] p-1'
        )}
        onKeyDown={panel === 'date' ? undefined : handleMenuKeyDown}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          onReturnFocus()
        }}
        // The chips toggle the panel themselves; letting the outside-press
        // close it first would reopen it on the same click.
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault()
        }}
      >
        {panel === 'date' ? (
          <DatePickerContent
            selected={merged.dueDate}
            showRemoveDate={Boolean(merged.dueDate)}
            time={merged.dueTime}
            onTimeChange={(time) => onChange({ dueDate: merged.dueDate, dueTime: time })}
            onSelect={(date) => {
              onChange({ dueDate: date, dueTime: date ? merged.dueTime : null })
              close()
            }}
          />
        ) : (
          renderView()
        )}
      </PopoverContent>
    </Popover>
  )
}
