/**
 * Editing a date pill on a touch surface (#2103).
 *
 * The pills have rendered since the schema landed, but a tap did nothing:
 * desktop opens `date-mention-popover.tsx` from a click and mobile had no
 * equivalent, so a date inserted from the `@` menu was frozen at whatever the
 * menu guessed. This module is that popover's phone shape — the same fields,
 * the same writes.
 *
 * Nothing here invents a format. The value is read off the pill's `data-*`
 * attributes exactly as desktop reads them, the write goes back through the
 * same `dateMention` inline content with the same six props, and the instant
 * is built with `new Date(y, mo - 1, d, h, mi, 0, 0).toISOString()` — desktop's
 * `emitYMDHM`, character for character. A pill edited here and a pill edited on
 * the desktop serialize to the same `((date:…))` bytes.
 *
 * **Remind is deliberately absent.** Desktop's popover offers it; mobile does
 * not, because a date pill's reminder is delivered by desktop's note-content
 * reconciler and `features/notes/reminders.ts` says in as many words that
 * mobile never reads, writes or schedules a `targetType: 'note_date'` row.
 * Offering the row would arm a bell glyph on a phone that will never ring. The
 * stored `remind` value is carried through every write untouched, so a reminder
 * set on the desktop survives an edit made here.
 */

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------

/**
 * The pill's text, and the reason this module imports nothing.
 *
 * Everything below turns an instant into a LOCAL calendar day, which is the one
 * class of bug a test on a UTC CI runner cannot see: `2026-03-02T04:00Z` is a
 * Sunday in Los Angeles and a Monday in Kiritimati, and both readings look
 * right at UTC. An import-free module can be loaded by a real child `node` with
 * a real `TZ` (`date-mention-sheet.test.ts`), which is the only way to prove it.
 */

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 0 = Sunday, 1 = Monday, the two values `calendar.weekStartDay` can take. */
export type WeekStart = 0 | 1

/**
 * The week start the host reported, mirrored from the `cfg` message.
 *
 * Module state for the same reason desktop's `setDateMentionPrefs` is: a pill
 * is raw DOM built inside an inline-content `render`, with no route to the
 * bridge or to the host's settings. Monday until told otherwise — the default
 * `settings-schemas.ts` ships, so a phone that never hears a week start reads
 * the same as a desktop nobody has configured.
 */
let prefWeekStart: WeekStart = 1

export function setDateMentionWeekStart(weekStart: WeekStart): void {
  prefWeekStart = weekStart
}

/** Midnight on the first day of `date`'s week. DST-safe: `setDate` walks days. */
function startOfWeek(date: Date, weekStart: WeekStart): Date {
  const start = startOfDay(date)
  start.setDate(start.getDate() - ((start.getDay() - weekStart + 7) % 7))
  return start
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date.getTime())
  next.setDate(next.getDate() + days)
  return next
}

function absoluteDate(date: Date): string {
  return `${date.getDate()} ${date.toLocaleDateString(undefined, { month: 'short' })}, ${date.getFullYear()}`
}

/**
 * Desktop's relative-day ladder, verbatim (`date-mention.tsx`).
 *
 * Today / Tomorrow / Yesterday, then the week tier — `This <Weekday>` ahead,
 * a bare weekday for a day already past in the current week, `Next` / `Last`
 * for the neighbouring weeks — and an absolute date beyond that. Which week a
 * date falls in is the whole reason `weekStart` had to reach the guest.
 */
function relativeDay(date: Date, now: Date, weekStart: WeekStart): string {
  const days = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'

  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' })
  const week = startOfWeek(date, weekStart).getTime()
  const thisWeek = startOfWeek(now, weekStart)
  if (week === thisWeek.getTime()) return days >= 2 ? `This ${weekday}` : weekday
  if (week === shiftDays(thisWeek, 7).getTime()) return `Next ${weekday}`
  if (week === shiftDays(thisWeek, -7).getTime()) return `Last ${weekday}`
  return absoluteDate(date)
}

/** The text a date pill shows. */
export function dateMentionLabel(props: {
  dateISO: string
  hasTime: boolean
  dateFormat: string
  timeFormat: string
  /** Injected by the tests; the pill itself always means "now". */
  now?: Date
  /** Injected by the tests; the pill itself uses what `cfg` reported. */
  weekStart?: WeekStart
}): string {
  const date = props.dateISO ? new Date(props.dateISO) : null
  if (!date || Number.isNaN(date.getTime())) return 'Date'

  const label =
    props.dateFormat === 'full'
      ? absoluteDate(date)
      : relativeDay(date, props.now ?? new Date(), props.weekStart ?? prefWeekStart)

  if (!props.hasTime) return label

  const hour12 = props.timeFormat === '12h' ? true : props.timeFormat === '24h' ? false : undefined
  return `${label} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12 })}`
}

export type DateMentionDateFormat = 'relative' | 'full'
export type DateMentionTimeFormat = 'system' | '12h' | '24h'

export interface DateMentionValue {
  dateISO: string
  hasTime: boolean
  dateFormat: DateMentionDateFormat
  remind: string
  timeFormat: DateMentionTimeFormat
}

/**
 * The `remind` offsets that mean something for a date WITHOUT a time, from
 * desktop's `remindOptions(false)`.
 *
 * Turning the clock off a pill reminding "15 minutes before" leaves an offset
 * with nothing to be relative to; desktop's `handleToggleTime` falls back to
 * `at` and so does this, so the phone can never write a combination the
 * desktop popover refuses to produce.
 */
const DATE_ONLY_REMINDS: readonly string[] = ['none', 'at', '1d', '2d', '1w']

export function reconcileRemind(hasTime: boolean, remind: string): string {
  if (hasTime) return remind
  return DATE_ONLY_REMINDS.includes(remind) ? remind : 'at'
}

// ---------------------------------------------------------------------------
// Reading a pill
// ---------------------------------------------------------------------------

export interface DateMentionTarget {
  anchorId: string
  value: DateMentionValue
}

/**
 * The pill's own props, off its DOM.
 *
 * Same source desktop's click handler uses. `null` for a pill with no anchor or
 * an unreadable date: there is nothing to seed a sheet with, and opening one on
 * a guess would write a date the note never had.
 */
export function readDateMentionTarget(pill: HTMLElement): DateMentionTarget | null {
  const anchorId = pill.getAttribute('data-anchor-id')
  const dateISO = pill.getAttribute('data-date-iso')
  if (!anchorId || !dateISO || Number.isNaN(new Date(dateISO).getTime())) return null
  const dateFormat = pill.getAttribute('data-date-format') === 'full' ? 'full' : 'relative'
  const rawTimeFormat = pill.getAttribute('data-time-format')
  return {
    anchorId,
    value: {
      dateISO,
      hasTime: pill.getAttribute('data-has-time') === 'true',
      dateFormat,
      remind: pill.getAttribute('data-remind') || 'none',
      timeFormat: rawTimeFormat === '12h' || rawTimeFormat === '24h' ? rawTimeFormat : 'system'
    }
  }
}

// ---------------------------------------------------------------------------
// Writing a pill
// ---------------------------------------------------------------------------

interface InlineLike {
  type?: string
  props?: { anchorId?: string }
}

interface BlockLike {
  /** BlockNote identifies the block to update by id, so it travels with it. */
  id: string
  content?: unknown
  children?: readonly BlockLike[]
}

/** The narrow slice of the editor these helpers need, so they stay testable. */
export interface DateMentionEditorSurface {
  readonly document: readonly BlockLike[]
  updateBlock(block: BlockLike, update: { content: unknown[] }): unknown
}

/**
 * Rewrite the one `dateMention` carrying `anchorId`, wherever it lives.
 *
 * Walks children too: a pill sits inside a list item's `children[]` as happily
 * as in a top-level paragraph, and desktop's `mutateDateMention` recurses for
 * the same reason. Stops at the first match — anchor ids are unique.
 */
function mutateDateMention(
  editor: DateMentionEditorSurface,
  anchorId: string,
  mutate: (content: unknown[], index: number) => unknown[]
): boolean {
  const walk = (blocks: readonly BlockLike[]): boolean => {
    for (const block of blocks) {
      const content = block.content
      if (Array.isArray(content)) {
        const index = content.findIndex(
          (item: InlineLike) => item?.type === 'dateMention' && item.props?.anchorId === anchorId
        )
        if (index !== -1) {
          editor.updateBlock(block, { content: mutate(content, index) })
          return true
        }
      }
      if (block.children?.length && walk(block.children)) return true
    }
    return false
  }
  return walk(editor.document)
}

export function updateDateMention(
  editor: DateMentionEditorSurface,
  anchorId: string,
  next: DateMentionValue
): boolean {
  return mutateDateMention(editor, anchorId, (content, index) => {
    const updated = [...content]
    updated[index] = {
      type: 'dateMention',
      props: {
        anchorId,
        dateISO: next.dateISO,
        hasTime: next.hasTime,
        dateFormat: next.dateFormat,
        remind: next.remind,
        timeFormat: next.timeFormat
      }
    }
    return updated
  })
}

/** Clear: splice the pill out of its block, leaving the sentence around it. */
export function removeDateMention(editor: DateMentionEditorSurface, anchorId: string): boolean {
  return mutateDateMention(editor, anchorId, (content, index) => {
    const updated = [...content]
    updated.splice(index, 1)
    return updated
  })
}

// ---------------------------------------------------------------------------
// Local wall-clock parts
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export interface WallClock {
  y: number
  mo: number
  d: number
  h: number
  mi: number
}

/** Every read and write is in the device's own timezone, as desktop's is. */
export function readWallClock(dateISO: string): WallClock {
  const date = new Date(dateISO)
  if (Number.isNaN(date.getTime())) return { y: 1970, mo: 1, d: 1, h: 9, mi: 0 }
  return {
    y: date.getFullYear(),
    mo: date.getMonth() + 1,
    d: date.getDate(),
    h: date.getHours(),
    mi: date.getMinutes()
  }
}

export function toDateInputValue(parts: WallClock): string {
  return `${parts.y}-${pad(parts.mo)}-${pad(parts.d)}`
}

export function toTimeInputValue(parts: WallClock): string {
  return `${pad(parts.h)}:${pad(parts.mi)}`
}

export function fromWallClock(parts: WallClock): string {
  return new Date(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, 0, 0).toISOString()
}

/**
 * `<input type="date">` reports `YYYY-MM-DD`, and `''` while a segment is
 * being cleared. Parsed by hand rather than by `new Date(raw)`, which reads a
 * bare date string as UTC midnight and lands on the previous day for anyone
 * west of Greenwich.
 */
export function parseDateInput(raw: string): { y: number; mo: number; d: number } | null {
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const y = Number(match[1])
  const mo = Number(match[2])
  const d = Number(match[3])
  const probe = new Date(y, mo - 1, d)
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null
  return { y, mo, d }
}

/** `HH:MM`, or `''` mid-edit — which `Number('')` would read as a valid 0. */
export function parseTimeInput(raw: string): { h: number; mi: number } | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const h = Number(match[1])
  const mi = Number(match[2])
  if (h > 23 || mi > 59) return null
  return { h, mi }
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const DATE_FORMAT_OPTIONS: ReadonlyArray<{ value: DateMentionDateFormat; label: string }> = [
  { value: 'relative', label: 'Relative' },
  { value: 'full', label: 'Full date' }
]

/**
 * What `system` resolves to on this device.
 *
 * Desktop prints the inherited setting in the row — "Default (24 hour)" — so
 * the user can see what the option means. Mobile has no clock-format setting to
 * inherit, so the honest answer is the device's own hour cycle, which is also
 * what the pill's `toLocaleTimeString` fallback already uses.
 */
export function deviceClockLabel(locale?: string): string {
  const resolved = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions()
  return resolved.hour12 ? '12 hour' : '24 hour'
}

function timeFormatOptions(
  locale?: string
): ReadonlyArray<{ value: DateMentionTimeFormat; label: string }> {
  return [
    { value: 'system', label: `Default (${deviceClockLabel(locale)})` },
    { value: '12h', label: '12 hour' },
    { value: '24h', label: '24 hour' }
  ]
}

export interface DateMentionSheetController {
  isOpen(): boolean
  close(): void
  setReadOnly(readOnly: boolean): void
  destroy(): void
}

function labelled(text: string, className: string): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = className
  element.textContent = text
  return element
}

/**
 * Tap a pill, get the popover's fields as a sheet over the keyboard's space.
 *
 * `pointerup` rather than `click`, for the reason `external-links.ts` and the
 * wiki-link chip both use it: the pills are `contenteditable="false"` and iOS
 * can move the node out from under a click.
 */
export function installDateMentionSheet(
  host: HTMLElement,
  editorRoot: HTMLElement,
  editor: DateMentionEditorSurface,
  onVisibilityChange?: (open: boolean) => void
): DateMentionSheetController {
  let target: DateMentionTarget | null = null
  let readOnly = false

  const emit = (): void => onVisibilityChange?.(target !== null)

  const commit = (next: DateMentionValue): void => {
    if (!target) return
    target = { anchorId: target.anchorId, value: next }
    updateDateMention(editor, target.anchorId, next)
    render()
  }

  const close = (): void => {
    if (!target) return
    target = null
    render()
    emit()
  }

  const optionRow = <T extends string>(
    title: string,
    value: T,
    options: ReadonlyArray<{ value: T; label: string }>,
    onSelect: (value: T) => void
  ): HTMLElement => {
    const section = document.createElement('section')
    const grid = document.createElement('div')
    grid.className = 'editor-picker-grid'
    for (const option of options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'editor-picker-card editor-date-option'
      button.setAttribute('aria-label', `${title}: ${option.label}`)
      button.setAttribute('aria-pressed', String(option.value === value))
      button.append(labelled(option.label, 'editor-picker-label'))
      if (option.value === value) button.append(labelled('✓', 'editor-picker-check'))
      button.addEventListener('click', () => onSelect(option.value))
      grid.append(button)
    }
    section.append(labelled(title, 'editor-picker-section-label'), grid)
    return section
  }

  const fieldRow = (label: string, control: HTMLElement): HTMLElement => {
    const row = document.createElement('div')
    row.className = 'editor-date-row'
    row.append(labelled(label, 'editor-date-row-label'), control)
    return row
  }

  function render(): void {
    host.replaceChildren()
    host.hidden = target === null
    if (!target) return

    const value = target.value
    const parts = readWallClock(value.dateISO)

    const shell = document.createElement('div')
    shell.className = 'editor-toolbar-shell editor-date-sheet-shell'
    const panel = document.createElement('section')
    panel.className = 'editor-picker editor-date-sheet'
    panel.setAttribute('aria-label', 'Date options')

    const header = document.createElement('div')
    header.className = 'editor-picker-header'
    const done = document.createElement('button')
    done.type = 'button'
    done.className = 'editor-date-done'
    done.textContent = 'Done'
    done.setAttribute('aria-label', 'Close date options')
    done.addEventListener('click', close)
    header.append(labelled('Date', 'editor-date-title'), done)
    panel.append(header)

    const scroll = document.createElement('div')
    scroll.className = 'editor-picker-scroll'

    const dateInput = document.createElement('input')
    dateInput.type = 'date'
    dateInput.className = 'editor-date-input'
    dateInput.setAttribute('aria-label', 'Date')
    dateInput.value = toDateInputValue(parts)
    dateInput.addEventListener('change', () => {
      const picked = parseDateInput(dateInput.value)
      if (!picked) return
      commit({ ...value, dateISO: fromWallClock({ ...parts, ...picked }) })
    })
    scroll.append(fieldRow('Date', dateInput))

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'editor-date-switch'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-checked', String(value.hasTime))
    toggle.setAttribute('aria-label', 'Include time')
    toggle.append(labelled('', 'editor-date-switch-knob'))
    toggle.addEventListener('click', () => {
      const hasTime = !value.hasTime
      commit({ ...value, hasTime, remind: reconcileRemind(hasTime, value.remind) })
    })
    scroll.append(fieldRow('Include time', toggle))

    if (value.hasTime) {
      const timeInput = document.createElement('input')
      timeInput.type = 'time'
      timeInput.className = 'editor-date-input'
      timeInput.setAttribute('aria-label', 'Time')
      timeInput.value = toTimeInputValue(parts)
      timeInput.addEventListener('change', () => {
        const picked = parseTimeInput(timeInput.value)
        if (!picked) return
        commit({ ...value, dateISO: fromWallClock({ ...parts, ...picked }) })
      })
      scroll.append(fieldRow('Time', timeInput))
    }

    scroll.append(
      optionRow('Date format', value.dateFormat, DATE_FORMAT_OPTIONS, (dateFormat) =>
        commit({ ...value, dateFormat })
      )
    )

    if (value.hasTime) {
      scroll.append(
        optionRow(
          'Time format',
          value.timeFormat,
          timeFormatOptions(document.documentElement.lang || undefined),
          (timeFormat) => commit({ ...value, timeFormat })
        )
      )
    }

    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'editor-date-clear'
    clear.textContent = 'Remove date'
    clear.setAttribute('aria-label', 'Remove date')
    clear.addEventListener('click', () => {
      const anchorId = target?.anchorId
      if (anchorId) removeDateMention(editor, anchorId)
      close()
    })
    scroll.append(clear)

    panel.append(scroll)
    shell.append(panel)
    host.append(shell)
  }

  const onPointerUp = (event: Event): void => {
    if (readOnly) return
    const node = event.target
    if (!(node instanceof HTMLElement)) return
    const pill = node.closest<HTMLElement>('[data-date-mention]')
    if (!pill) return
    const next = readDateMentionTarget(pill)
    if (!next) return
    event.preventDefault()
    // The sheet takes the keyboard's space, so the keyboard has to go — and the
    // caret is not what the edit applies to here, the anchor id is.
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    target = next
    render()
    emit()
  }

  editorRoot.addEventListener('pointerup', onPointerUp)
  render()

  return {
    isOpen: () => target !== null,
    close,
    setReadOnly(next) {
      readOnly = next
      if (next) close()
    },
    destroy() {
      editorRoot.removeEventListener('pointerup', onPointerUp)
      const wasOpen = target !== null
      target = null
      host.replaceChildren()
      host.hidden = true
      if (wasOpen) emit()
    }
  }
}
