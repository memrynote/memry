import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTabActionsOptional } from '@/contexts/tabs'
import { isMac } from '@/hooks/use-keyboard-shortcuts'
import { LOCAL_COMMAND_MENU_ATTR } from '@/hooks/use-search-shortcut'
import { CalendarDays } from '@/lib/icons'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { dayIndexFromDate, toLocalDateString } from './date-utils'
import { TimelineActionBar } from './timeline-action-bar'
import { TimelineGroupBySelect } from './timeline-controls'
import {
  TimelineActionPanel,
  type TimelinePanelPage,
  type TimelineTaskAction
} from './timeline-action-panel'
import {
  TIMELINE_AXIS_HEIGHT,
  TIMELINE_LIST_WIDTH,
  TimelineAxis,
  TimelineGrid,
  TimelineTodayLine
} from './timeline-axis'
import {
  TIMELINE_DAY_WIDTH,
  applyTimelineEdit,
  buildTimelineGroups,
  dateAtOffset,
  dayOffset,
  getTimelineWindow,
  isSameTimelinePeriod,
  shapeBounds,
  timelinePeriodStart,
  type TimelineDates,
  type TimelineEdit,
  type TimelineRow,
  type TimelineSettings,
  type TimelineTaskRow,
  type TimelineZoom
} from './timeline-model'
import {
  TimelineEventRowView,
  TimelineGroupHeader,
  TimelineTaskRowView,
  useDayFormatter,
  useDescribeShape
} from './timeline-rows'
import type { AnchorRect } from './types'
import { useTimelineDrag } from './use-timeline-drag'
import { useTimelineTaskActions } from './use-timeline-task-actions'
import type { Task } from '@/data/task-model'

/** Where the date being navigated to sits, as a share of the visible track. */
const FOCUS_FRACTION = 0.25
const NO_ITEMS: CalendarProjectionItem[] = []

interface CalendarTimelineViewProps {
  anchorDate: string
  weekStartsOn?: 0 | 1
  settings: TimelineSettings
  items?: CalendarProjectionItem[]
  /** Task or event whose popover the page has open. */
  openItemId?: string | null
  todayRequestKey?: number
  onAnchorChange?: (date: string) => void
  onSettingsChange?: (settings: TimelineSettings) => void
  onOpenTask?: (taskId: string, rect: AnchorRect) => void
  onOpenEvent?: (item: CalendarProjectionItem, rect: AnchorRect) => void
}

function rowDomId(key: string): string {
  return `timeline-row-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function toAnchorRect(rect: DOMRect): AnchorRect {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

function isInteractiveTarget(target: EventTarget, root: Element): boolean {
  if (!(target instanceof Element) || target === root) return false
  return target.closest('button, input, textarea, select, [contenteditable="true"]') !== null
}

function getInline(el: HTMLElement, rtl: boolean): number {
  return rtl ? -el.scrollLeft : el.scrollLeft
}

function setInline(el: HTMLElement, x: number, rtl: boolean): void {
  el.scrollLeft = rtl ? -x : x
}

/**
 * Gantt view of scheduled work: a sticky task list on the start side, a
 * continuous day axis on the other. Scrolling past a period moves the
 * calendar's anchor, and the laid-out window slides with it.
 */
export function CalendarTimelineView({
  anchorDate,
  weekStartsOn = 1,
  settings,
  items = NO_ITEMS,
  openItemId = null,
  todayRequestKey,
  onAnchorChange,
  onSettingsChange,
  onOpenTask,
  onOpenEvent
}: CalendarTimelineViewProps): React.JSX.Element {
  const { t } = useT('calendar')
  const actions = useTimelineTaskActions()
  const tabActions = useTabActionsOptional()
  const today = toLocalDateString(new Date())
  const { zoom } = settings
  const dayWidth = TIMELINE_DAY_WIDTH[zoom]
  const formatDay = useDayFormatter(today)
  const describe = useDescribeShape(formatDay)

  const timelineWindow = useMemo(
    () => getTimelineWindow(anchorDate, zoom, weekStartsOn),
    [anchorDate, zoom, weekStartsOn]
  )
  const trackWidth = timelineWindow.dayCount * dayWidth

  const groups = useMemo(
    () =>
      buildTimelineGroups({
        tasks: actions.tasks,
        projects: actions.projects,
        events: items,
        window: timelineWindow,
        today,
        settings
      }),
    [actions.tasks, actions.projects, items, timelineWindow, today, settings]
  )

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const visibleRows = useMemo(
    () => groups.flatMap((group) => (collapsed.has(group.key) ? [] : group.rows)),
    [groups, collapsed]
  )
  const taskRowCount = useMemo(
    () => groups.reduce((n, g) => n + g.rows.filter((row) => row.type === 'task').length, 0),
    [groups]
  )
  const eventRowCount = groups.find((group) => group.key === 'events')?.rows.length ?? 0

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selectedRow = visibleRows.find((row) => row.key === selectedKey) ?? null
  const selectedTaskRow = selectedRow?.type === 'task' ? selectedRow : null

  const [panelOpen, setPanelOpen] = useState(false)
  const [panelPage, setPanelPage] = useState<TimelinePanelPage>('root')

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const isRtl = useCallback(
    () => (scrollRef.current ? getComputedStyle(scrollRef.current).direction === 'rtl' : false),
    []
  )

  // ---------------------------------------------------------------------------
  // Scroll <-> anchor
  //
  // The anchor decides which window is laid out. Toolbar steps and Today move
  // the anchor and the view scrolls to it; scrolling past a period moves the
  // anchor, the window slides, and the scroll offset is compensated so nothing
  // on screen jumps.
  // ---------------------------------------------------------------------------
  const latestRef = useRef({ anchorDate, timelineWindow, dayWidth, zoom, weekStartsOn })
  useLayoutEffect(() => {
    latestRef.current = { anchorDate, timelineWindow, dayWidth, zoom, weekStartsOn }
  })
  const emittedAnchorRef = useRef<string | null>(null)
  const focusDateRef = useRef(anchorDate)
  const pendingScrollDateRef = useRef<string | null>(null)
  const syncRef = useRef<{
    anchor: string
    windowStart: string
    zoom: TimelineZoom
    todayKey: number | undefined
  } | null>(null)
  const frameRef = useRef(0)

  const focusPx = useCallback((): number => {
    const el = scrollRef.current
    if (!el) return 0
    return Math.max(0, el.clientWidth - TIMELINE_LIST_WIDTH) * FOCUS_FRACTION
  }, [])

  const scrollToDate = useCallback(
    (date: string): void => {
      const el = scrollRef.current
      if (!el) return
      const { timelineWindow: win, dayWidth: width } = latestRef.current
      setInline(el, Math.max(0, dayOffset(date, win) * width - focusPx()), isRtl())
    },
    [focusPx, isRtl]
  )

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const previous = syncRef.current
    syncRef.current = {
      anchor: anchorDate,
      windowStart: timelineWindow.start,
      zoom,
      todayKey: todayRequestKey
    }
    const pending = pendingScrollDateRef.current
    pendingScrollDateRef.current = null

    if (!previous) {
      scrollToDate(
        anchorDate === today ? today : timelinePeriodStart(anchorDate, zoom, weekStartsOn)
      )
      return
    }
    if (previous.todayKey !== todayRequestKey) {
      scrollToDate(today)
      return
    }
    if (pending) {
      scrollToDate(pending)
      return
    }
    if (previous.zoom !== zoom) {
      scrollToDate(focusDateRef.current)
      return
    }
    if (previous.anchor === anchorDate && previous.windowStart === timelineWindow.start) return
    if (anchorDate === emittedAnchorRef.current) {
      const shiftDays =
        dayIndexFromDate(previous.windowStart) - dayIndexFromDate(timelineWindow.start)
      if (shiftDays !== 0) {
        const rtl = isRtl()
        setInline(el, getInline(el, rtl) + shiftDays * dayWidth, rtl)
      }
      return
    }
    if (
      previous.windowStart === timelineWindow.start &&
      isSameTimelinePeriod(previous.anchor, anchorDate, zoom, weekStartsOn)
    ) {
      return
    }
    scrollToDate(timelinePeriodStart(anchorDate, zoom, weekStartsOn))
  }, [
    anchorDate,
    timelineWindow.start,
    zoom,
    todayRequestKey,
    today,
    weekStartsOn,
    dayWidth,
    scrollToDate,
    isRtl
  ])

  const handleScroll = (): void => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      const el = scrollRef.current
      if (!el) return
      const latest = latestRef.current
      const offset = Math.floor((getInline(el, isRtl()) + focusPx()) / latest.dayWidth)
      const clamped = Math.min(Math.max(offset, 0), latest.timelineWindow.dayCount - 1)
      const date = dateAtOffset(clamped, latest.timelineWindow)
      focusDateRef.current = date
      if (!isSameTimelinePeriod(date, latest.anchorDate, latest.zoom, latest.weekStartsOn)) {
        emittedAnchorRef.current = date
        onAnchorChange?.(date)
      }
    })
  }

  /** Scroll a day into view, moving the anchor first when it is outside the window. */
  const revealDay = useCallback(
    (date: string): void => {
      const el = scrollRef.current
      if (!el) return
      const { timelineWindow: win, dayWidth: width } = latestRef.current
      if (date < win.start || date > win.end) {
        pendingScrollDateRef.current = date
        onAnchorChange?.(date)
        return
      }
      const rtl = isRtl()
      const x = dayOffset(date, win) * width
      const visibleStart = getInline(el, rtl)
      const visibleEnd = visibleStart + el.clientWidth - TIMELINE_LIST_WIDTH
      if (x < visibleStart || x + width > visibleEnd) scrollToDate(date)
    },
    [onAnchorChange, isRtl, scrollToDate]
  )

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  const commitDates = useCallback(
    (task: Task, dates: TimelineDates): void => {
      actions.setDates(task, dates)
      const first = dates.startDate ?? dates.dueDate
      if (first) revealDay(first)
    },
    [actions, revealDay]
  )

  const drag = useTimelineDrag({
    window: timelineWindow,
    dayWidth,
    scrollRef,
    listWidth: TIMELINE_LIST_WIDTH,
    isRtl,
    onCommit: commitDates
  })

  const nudge = (row: TimelineTaskRow, edit: TimelineEdit, delta: number): void => {
    if (row.shape.kind === 'none') return
    commitDates(row.task, applyTimelineEdit(row.shape, edit, delta))
  }

  const setDateField = (task: Task, field: 'start' | 'due', date: string | null): void => {
    const start = task.startDate ? toLocalDateString(task.startDate) : null
    const due = task.dueDate ? toLocalDateString(task.dueDate) : null
    if (field === 'start') {
      // A start after the due date pulls the due date along.
      commitDates(task, { startDate: date, dueDate: date && due && date > due ? date : due })
    } else {
      // A due date before the start drops the start: the task is now a milestone.
      commitDates(task, { startDate: date && start && start > date ? null : start, dueDate: date })
    }
  }

  // ---------------------------------------------------------------------------
  // Selection and opening
  // ---------------------------------------------------------------------------

  const focusGrid = (): void => scrollRef.current?.focus({ preventScroll: true })

  const select = (key: string): void => {
    setSelectedKey(key)
    focusGrid()
  }

  const moveSelection = (to: number): void => {
    const row = visibleRows[Math.min(Math.max(to, 0), visibleRows.length - 1)]
    if (!row) return
    setSelectedKey(row.key)
    document.getElementById(rowDomId(row.key))?.scrollIntoView?.({ block: 'nearest' })
    const bounds =
      row.type === 'task' ? shapeBounds(row.shape) : { first: row.start, last: row.end }
    if (bounds) revealDay(bounds.first)
  }

  const rowRect = (row: TimelineRow): AnchorRect => {
    const el = document.getElementById(rowDomId(row.key))
    const target =
      el?.querySelector(
        '[data-testid="timeline-task-bar"], [data-testid="timeline-task-milestone"], [data-testid="timeline-event-bar"]'
      ) ??
      el?.querySelector('[role="gridcell"]') ??
      el
    return target
      ? toAnchorRect(target.getBoundingClientRect())
      : { x: 0, y: 0, width: 0, height: 0 }
  }

  const openRow = (row: TimelineRow): void => {
    if (row.type === 'task') onOpenTask?.(row.task.id, rowRect(row))
    else onOpenEvent?.(row.item, rowRect(row))
  }

  const openInTasks = (task: Task): void => {
    tabActions?.openTab({
      type: 'tasks',
      title: 'Tasks',
      icon: 'CheckSquare',
      path: '/tasks',
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false,
      viewState: {
        openTaskId: task.id,
        selectedProjectId: task.projectId,
        activeInternalTab: 'all',
        activeTab: 'all'
      }
    })
  }

  const runAction = (row: TimelineTaskRow, action: TimelineTaskAction): void => {
    switch (action) {
      case 'open':
        openRow(row)
        return
      case 'open-in-tasks':
        openInTasks(row.task)
        return
      case 'move-later':
        nudge(row, 'move', 7)
        return
      case 'move-earlier':
        nudge(row, 'move', -7)
        return
      case 'clear-dates':
        commitDates(row.task, { startDate: null, dueDate: null })
        return
      case 'complete':
        actions.complete(row.task.id)
        return
      case 'uncomplete':
        actions.uncomplete(row.task.id)
    }
  }

  const openPanel = (page: TimelinePanelPage): void => {
    setPanelPage(page)
    setPanelOpen(true)
  }

  const scrollToToday = (): void => {
    const { timelineWindow: win } = latestRef.current
    if (today >= win.start && today <= win.end) {
      scrollToDate(today)
    } else {
      pendingScrollDateRef.current = today
      onAnchorChange?.(today)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (isInteractiveTarget(event.target, event.currentTarget)) return
    const mod = isMac ? event.metaKey : event.ctrlKey
    const { key, shiftKey, altKey } = event
    const index = selectedRow ? visibleRows.indexOf(selectedRow) : -1
    const arrow = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0
    // Arrows follow the timeline's direction, which runs leftward in RTL.
    const step = isRtl() ? -arrow : arrow
    let handled = true

    if (key === 'ArrowDown' && !mod && !altKey) {
      moveSelection(index + 1)
    } else if (key === 'ArrowUp' && !mod && !altKey) {
      moveSelection(index < 0 ? 0 : index - 1)
    } else if (key === 'Home' && !mod) {
      moveSelection(0)
    } else if (key === 'End' && !mod) {
      moveSelection(visibleRows.length - 1)
    } else if (key === 'Escape' && selectedRow) {
      setSelectedKey(null)
    } else if ((key === 't' || key === 'T') && !mod && !altKey && !shiftKey) {
      scrollToToday()
    } else if (key === 'Enter' && selectedRow) {
      if (mod && selectedTaskRow) openInTasks(selectedTaskRow.task)
      else openRow(selectedRow)
    } else if (selectedTaskRow && step !== 0 && altKey && !mod) {
      nudge(selectedTaskRow, shiftKey ? 'resize-start' : 'resize-end', step)
    } else if (selectedTaskRow && step !== 0 && shiftKey && !mod) {
      nudge(selectedTaskRow, 'move', step)
    } else if (selectedTaskRow && mod && !altKey && key.toLowerCase() === 'k') {
      openPanel('root')
    } else if (selectedTaskRow && !mod && !altKey) {
      switch (key.toLowerCase()) {
        case 'w':
          nudge(selectedTaskRow, 'move', shiftKey ? -7 : 7)
          break
        case 's':
          openPanel('start')
          break
        case 'd':
          openPanel('due')
          break
        case 'p':
          openPanel('project')
          break
        case 'c':
          runAction(selectedTaskRow, selectedTaskRow.isCompleted ? 'uncomplete' : 'complete')
          break
        case 'backspace':
        case 'delete':
          if (selectedTaskRow.shape.kind !== 'none') runAction(selectedTaskRow, 'clear-dates')
          else handled = false
          break
        default:
          handled = false
      }
    } else {
      handled = false
    }

    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const geometry = { window: timelineWindow, dayWidth }
  const openTaskKey = openItemId ? `task:${openItemId}` : null
  const isRowSelected = (row: TimelineRow): boolean =>
    row.key === selectedKey ||
    row.key === openTaskKey ||
    (row.type === 'event' && row.item.sourceId === openItemId)

  const selection = selectedRow
    ? selectedRow.type === 'task'
      ? {
          kind: 'task' as const,
          title: selectedRow.task.title || t('timeline.untitled'),
          detail: describe(selectedRow.shape, selectedRow.isOverdue),
          color: selectedRow.color
        }
      : {
          kind: 'event' as const,
          title: selectedRow.item.title,
          detail: describe(
            selectedRow.start === selectedRow.end
              ? { kind: 'due', date: selectedRow.start }
              : { kind: 'span', start: selectedRow.start, end: selectedRow.end }
          ),
          color: selectedRow.color
        }
    : null

  return (
    <div className="flex h-full flex-col" data-testid="calendar-view" data-view="timeline">
      <div
        ref={scrollRef}
        role="grid"
        tabIndex={0}
        aria-label={t('timeline.label')}
        aria-activedescendant={selectedRow ? rowDomId(selectedRow.key) : undefined}
        data-calendar-scroll
        {...{ [LOCAL_COMMAND_MENU_ATTR]: '' }}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 overflow-auto overscroll-x-contain outline-none"
      >
        <div className="relative min-h-full" style={{ width: TIMELINE_LIST_WIDTH + trackWidth }}>
          <TimelineAxis
            {...geometry}
            zoom={zoom}
            weekStartsOn={weekStartsOn}
            today={today}
            listLabel={t('timeline.tasks-column')}
            listCount={taskRowCount}
            listTrailing={
              onSettingsChange && (
                <TimelineGroupBySelect
                  variant="header"
                  value={settings.groupBy}
                  onChange={(groupBy) => onSettingsChange({ ...settings, groupBy })}
                />
              )
            }
          />

          <div
            className="relative pb-10"
            style={{ minHeight: `calc(100% - ${TIMELINE_AXIS_HEIGHT}px)` }}
          >
            <TimelineGrid {...geometry} zoom={zoom} today={today} />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-10 w-px bg-border"
              style={{ insetInlineStart: TIMELINE_LIST_WIDTH - 1 }}
            />

            {groups.length === 0 ? (
              <div
                className="sticky start-0 flex flex-col items-center justify-center gap-2 px-6 py-20 text-center"
                style={{ width: 'min(100%, 40rem)' }}
              >
                <CalendarDays className="size-5 text-text-tertiary" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">{t('timeline.empty-title')}</p>
                <p className="max-w-sm text-xs text-text-secondary">{t('timeline.empty-body')}</p>
              </div>
            ) : (
              groups.map((group) => {
                const isCollapsed = collapsed.has(group.key)
                return (
                  <div key={group.key} role="rowgroup" aria-label={groupLabel(group, t)}>
                    <TimelineGroupHeader
                      {...geometry}
                      group={group}
                      collapsed={isCollapsed}
                      onToggle={() =>
                        setCollapsed((current) => {
                          const next = new Set(current)
                          if (next.has(group.key)) next.delete(group.key)
                          else next.add(group.key)
                          return next
                        })
                      }
                    />
                    {!isCollapsed &&
                      group.rows.map((row) =>
                        row.type === 'task' ? (
                          <TimelineTaskRowView
                            key={row.key}
                            {...geometry}
                            row={row}
                            domId={rowDomId(row.key)}
                            today={today}
                            isSelected={isRowSelected(row)}
                            preview={
                              drag.preview?.taskId === row.task.id ? drag.preview.dates : null
                            }
                            formatDay={formatDay}
                            describe={describe}
                            onSelect={() => select(row.key)}
                            onOpen={() => openRow(row)}
                            onBarPointerDown={(event, edit) => {
                              select(row.key)
                              drag.startEdit(event, row.task, row.shape, edit)
                            }}
                            onToggleComplete={() =>
                              runAction(row, row.isCompleted ? 'uncomplete' : 'complete')
                            }
                            onSchedulePointerDown={(event) => drag.startSchedule(event, row.task)}
                            dayFromPointer={drag.dayFromPointer}
                          />
                        ) : (
                          <TimelineEventRowView
                            key={row.key}
                            {...geometry}
                            row={row}
                            domId={rowDomId(row.key)}
                            isSelected={isRowSelected(row)}
                            formatDay={formatDay}
                            onSelect={() => select(row.key)}
                            onOpen={() => openRow(row)}
                          />
                        )
                      )}
                  </div>
                )
              })
            )}

            <TimelineTodayLine {...geometry} today={today} />
          </div>
        </div>
      </div>

      <TimelineActionBar
        selection={selection}
        summary={t('timeline.bar.summary', { tasks: taskRowCount, events: eventRowCount })}
        renderActionsTrigger={(trigger) => (
          <TimelineActionPanel
            open={panelOpen}
            onOpenChange={(open) => {
              setPanelOpen(open)
              if (open) setPanelPage('root')
            }}
            page={panelPage}
            onPageChange={setPanelPage}
            task={selectedTaskRow?.task ?? null}
            taskColor={selectedTaskRow?.color ?? 'var(--color-tint)'}
            projectName={selectedTaskRow?.projectName ?? ''}
            projects={actions.projects}
            weekStartsOn={weekStartsOn}
            onAction={(action) => selectedTaskRow && runAction(selectedTaskRow, action)}
            onSetDate={(field, date) =>
              selectedTaskRow && setDateField(selectedTaskRow.task, field, date)
            }
            onMoveToProject={(projectId) =>
              selectedTaskRow && actions.moveToProject(selectedTaskRow.task.id, projectId)
            }
            onCloseAutoFocus={focusGrid}
          >
            {trigger}
          </TimelineActionPanel>
        )}
      />
    </div>
  )
}

function groupLabel(
  group: ReturnType<typeof buildTimelineGroups>[number],
  t: (key: string) => string
): string {
  switch (group.heading.kind) {
    case 'project':
      return group.heading.name
    case 'events':
      return t('timeline.events')
    case 'status':
      return t(`timeline.status.${group.heading.status}`)
    case 'priority':
      return t(`timeline.priority.${group.heading.priority}`)
    case 'all':
      return t('timeline.tasks-column')
  }
}

export default CalendarTimelineView
