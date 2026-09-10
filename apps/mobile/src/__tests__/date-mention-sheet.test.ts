// @vitest-environment jsdom

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import {
  dateMentionLabel,
  installDateMentionSheet,
  readDateMentionTarget,
  reconcileRemind,
  removeDateMention,
  updateDateMention,
  type DateMentionEditorSurface
} from '../../editor-web/src/date-mentions'

/**
 * The date pill's sheet, and the label tier it finally has a week start for
 * (#2103).
 *
 * Two things are being proved. The label ladder must agree with desktop's on
 * both week starts, because the same note is read on both. And every write the
 * sheet makes must be the write desktop's popover makes — the same six props,
 * the same local-midnight instant — so a pill edited on a phone opens on a
 * desktop build that predates this sheet.
 */

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

/** A local date at noon, so no assertion here can trip over a DST hour. */
function local(y: number, mo: number, d: number, h = 12, mi = 0): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

/** Asserted through the same API the label uses, so no assertion is locale-bound. */
function weekdayOf(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long' })
}

function label(date: Date, now: Date, weekStart: 0 | 1): string {
  return dateMentionLabel({
    dateISO: date.toISOString(),
    hasTime: false,
    dateFormat: 'relative',
    timeFormat: 'system',
    now,
    weekStart
  })
}

describe('dateMentionLabel relative ladder', () => {
  // Thursday 10 September 2026.
  const now = local(2026, 9, 10)

  it('names the neighbouring days before it reaches the week tier', () => {
    expect(label(now, now, 1)).toBe('Today')
    expect(label(local(2026, 9, 11), now, 1)).toBe('Tomorrow')
    expect(label(local(2026, 9, 9), now, 1)).toBe('Yesterday')
  })

  it('reads the same Saturday differently on each week start', () => {
    // Saturday 12 September. A Monday week runs 7-13 Sep, so it is still
    // "this" week; a Sunday week runs 6-12 Sep, and it is the last day of it.
    // Either way it is ahead, so it takes the `This` prefix.
    const saturday = local(2026, 9, 12)
    expect(label(saturday, now, 1)).toBe(`This ${weekdayOf(saturday)}`)
    expect(label(saturday, now, 0)).toBe(`This ${weekdayOf(saturday)}`)

    // Sunday 13 September is the tie-breaker: the last day of the Monday week
    // and the first day of the NEXT Sunday one.
    const sunday = local(2026, 9, 13)
    expect(label(sunday, now, 1)).toBe(`This ${weekdayOf(sunday)}`)
    expect(label(sunday, now, 0)).toBe(`Next ${weekdayOf(sunday)}`)
  })

  it('prefixes the neighbouring weeks and gives up beyond them', () => {
    const nextWeek = local(2026, 9, 16)
    const lastWeek = local(2026, 9, 2)
    const monday = local(2026, 9, 7)
    expect(label(nextWeek, now, 1)).toBe(`Next ${weekdayOf(nextWeek)}`)
    expect(label(lastWeek, now, 1)).toBe(`Last ${weekdayOf(lastWeek)}`)
    // Monday 7 September is earlier in the current Monday week, so it reads as
    // a bare weekday — desktop drops the prefix for a day already gone.
    expect(label(monday, now, 1)).toBe(weekdayOf(monday))
    expect(label(local(2026, 9, 24), now, 1)).toMatch(/^24 \S+, 2026$/)
  })

  it('never reaches the ladder when the pill asks for a full date', () => {
    expect(
      dateMentionLabel({
        dateISO: now.toISOString(),
        hasTime: false,
        dateFormat: 'full',
        timeFormat: 'system',
        now,
        weekStart: 1
      })
    ).toMatch(/^10 \S+, 2026$/)
  })
})

// ---------------------------------------------------------------------------
// Day boundary, in a real timezone
// ---------------------------------------------------------------------------

/**
 * The guard the repo's history asks for.
 *
 * A day-boundary bug is invisible at UTC, and vitest's worker pool makes
 * `process.env.TZ` inert — assigning it never reaches the C++ `tzset`. So this
 * loads the module in a real child `node` with a real `TZ`, which is possible
 * only because `date-mentions.ts` imports nothing.
 */
function runInTz<T>(tz: string, script: string): T {
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8'
  })
  return JSON.parse(out) as T
}

describe('day boundaries in a real timezone', () => {
  const moduleUrl = pathToFileURL(
    resolve(dirname(expect.getState().testPath!), '../../editor-web/src/date-mentions.ts')
  ).href

  function inTz(tz: string, body: string): unknown {
    return runInTz(
      tz,
      `const m = await import(${JSON.stringify(moduleUrl)})\n` +
        `process.stdout.write(JSON.stringify((() => { ${body} })()))`
    )
  }

  // One instant, two readers. 2026-03-08T04:00Z is Saturday 7 March in Los
  // Angeles and Sunday 8 March in Kiritimati; against a "now" of
  // 2026-03-01T12:00Z (Sunday 1 March / Monday 2 March) that is the NEXT
  // Monday-week for one reader and the CURRENT one for the other. At UTC the
  // two readings are indistinguishable, which is the whole point.
  const instant = '2026-03-08T04:00:00.000Z'
  const now = '2026-03-01T12:00:00.000Z'

  it.each([
    ['America/Los_Angeles', /^Next \S+$/],
    ['Pacific/Kiritimati', /^This \S+$/]
  ])('reads the pill in the reader’s own week in %s', (tz, expected) => {
    expect(
      inTz(
        tz,
        `return m.dateMentionLabel({ dateISO: ${JSON.stringify(instant)}, hasTime: false,` +
          ` dateFormat: 'relative', timeFormat: 'system', weekStart: 1,` +
          ` now: new Date(${JSON.stringify(now)}) })`
      )
    ).toMatch(expected)
  })

  it.each(['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])(
    'round-trips a picked calendar day through the sheet in %s',
    (tz) => {
      // The regression this catches is `new Date('2026-03-01')`, which is UTC
      // midnight and lands on 28 February for every negative-offset reader.
      expect(
        inTz(
          tz,
          `const picked = m.parseDateInput('2026-03-01')\n` +
            `const iso = m.fromWallClock({ ...picked, h: 9, mi: 0 })\n` +
            `return m.toDateInputValue(m.readWallClock(iso))`
        )
      ).toBe('2026-03-01')
    }
  )
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function dateMention(anchorId: string, props: Record<string, unknown> = {}) {
  return {
    type: 'dateMention',
    props: {
      anchorId,
      dateISO: '2026-09-10T09:00:00.000Z',
      hasTime: false,
      dateFormat: 'relative',
      remind: 'none',
      timeFormat: 'system',
      ...props
    }
  }
}

function surface(document: unknown[]) {
  const updateBlock = vi.fn()
  return {
    editor: { document, updateBlock } as unknown as DateMentionEditorSurface,
    updateBlock
  }
}

describe('updateDateMention', () => {
  it('rewrites the pill in place and leaves the sentence around it', () => {
    const block = {
      id: 'b1',
      content: [{ type: 'text', text: 'due ' }, dateMention('dm_1'), { type: 'text', text: '!' }]
    }
    const { editor, updateBlock } = surface([block])

    expect(
      updateDateMention(editor, 'dm_1', {
        dateISO: '2026-12-24T18:30:00.000Z',
        hasTime: true,
        dateFormat: 'full',
        remind: 'none',
        timeFormat: '24h'
      })
    ).toBe(true)

    const content = updateBlock.mock.calls[0][1].content
    expect(content).toHaveLength(3)
    expect(content[1].type).toBe('dateMention')
    // All six props, because the vault token is built from all six.
    expect(content[1].props).toEqual({
      anchorId: 'dm_1',
      dateISO: '2026-12-24T18:30:00.000Z',
      hasTime: true,
      dateFormat: 'full',
      remind: 'none',
      timeFormat: '24h'
    })
  })

  it('finds a pill nested inside a list item', () => {
    const child = { id: 'b2', content: [dateMention('dm_2')] }
    const { editor, updateBlock } = surface([{ id: 'b1', content: [], children: [child] }])

    expect(
      updateDateMention(editor, 'dm_2', {
        dateISO: '2026-09-11T09:00:00.000Z',
        hasTime: false,
        dateFormat: 'relative',
        remind: '1d',
        timeFormat: 'system'
      })
    ).toBe(true)
    expect(updateBlock.mock.calls[0][0]).toBe(child)
  })

  it('leaves the document alone when no pill carries the anchor', () => {
    const { editor, updateBlock } = surface([{ id: 'b1', content: [dateMention('dm_1')] }])
    expect(removeDateMention(editor, 'dm_missing')).toBe(false)
    expect(updateBlock).not.toHaveBeenCalled()
  })
})

describe('removeDateMention', () => {
  it('splices the pill out', () => {
    const { editor, updateBlock } = surface([
      { id: 'b1', content: [{ type: 'text', text: 'due ' }, dateMention('dm_1')] }
    ])
    expect(removeDateMention(editor, 'dm_1')).toBe(true)
    expect(updateBlock.mock.calls[0][1].content).toEqual([{ type: 'text', text: 'due ' }])
  })
})

describe('reconcileRemind', () => {
  it('keeps every offset while the pill carries a time', () => {
    expect(reconcileRemind(true, '15m')).toBe('15m')
    expect(reconcileRemind(true, 'none')).toBe('none')
  })

  it('falls back to the day-of-event offset when the time is taken away', () => {
    // Desktop's `handleToggleTime`. A sub-hour offset has nothing to be
    // relative to once the pill is a date, and the phone must not write a
    // combination the desktop popover refuses to produce.
    expect(reconcileRemind(false, '15m')).toBe('at')
    expect(reconcileRemind(false, '1d')).toBe('1d')
    expect(reconcileRemind(false, 'none')).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

function pillElement(props: Record<string, string> = {}): HTMLElement {
  const pill = document.createElement('span')
  pill.setAttribute('data-date-mention', '')
  pill.setAttribute('data-anchor-id', 'dm_1')
  pill.setAttribute('data-date-iso', '2026-09-10T09:00:00.000Z')
  pill.setAttribute('data-has-time', 'false')
  pill.setAttribute('data-date-format', 'relative')
  pill.setAttribute('data-remind', 'none')
  pill.setAttribute('data-time-format', 'system')
  for (const [name, value] of Object.entries(props)) pill.setAttribute(name, value)
  return pill
}

function mountSheet(props: Record<string, string> = {}) {
  document.body.replaceChildren()
  const root = document.createElement('div')
  const host = document.createElement('div')
  const pill = pillElement(props)
  root.append(pill)
  document.body.append(root, host)

  const block = { id: 'b1', content: [dateMention('dm_1', { ...props })] }
  const { editor, updateBlock } = surface([block])
  const visibility = vi.fn()
  const controller = installDateMentionSheet(host, root, editor, visibility)
  return { controller, host, root, pill, updateBlock, visibility }
}

/** The real gesture: `pointerdown` then `pointerup`, because the sheet reads both. */
function tap(element: HTMLElement): void {
  element.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
  element.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }))
}

/** What the editor taking the caret back looks like — the keyboard coming up. */
function focusEditor(root: HTMLElement): void {
  root.dispatchEvent(new Event('focusin', { bubbles: true }))
}

function control(host: HTMLElement, name: string): HTMLElement {
  const match = host.querySelector<HTMLElement>(`[aria-label="${name}"]`)
  if (!match) throw new Error(`Missing control: ${name}`)
  return match
}

describe('the date sheet', () => {
  it('stays shut until a pill is tapped, and reports it', () => {
    const { controller, host, pill, visibility } = mountSheet()
    expect(controller.isOpen()).toBe(false)
    expect(host.hidden).toBe(true)

    tap(pill)
    expect(controller.isOpen()).toBe(true)
    expect(host.hidden).toBe(false)
    expect(visibility).toHaveBeenLastCalledWith(true)
    controller.destroy()
  })

  it('seeds itself from the pill rather than from a guess', () => {
    const { host, pill } = mountSheet({
      'data-has-time': 'true',
      'data-date-format': 'full',
      'data-time-format': '24h'
    })
    tap(pill)
    expect(control(host, 'Date format: Full date').getAttribute('aria-pressed')).toBe('true')
    expect(control(host, 'Include time').getAttribute('aria-checked')).toBe('true')
    expect(control(host, 'Time format: 24 hour').getAttribute('aria-pressed')).toBe('true')
  })

  it('hides the clock rows on a pill with no time', () => {
    const { host, pill } = mountSheet()
    tap(pill)
    expect(host.querySelector('[aria-label="Time"]')).toBeNull()
    expect(host.querySelector('[aria-label="Time format: 12 hour"]')).toBeNull()
  })

  it('writes a picked day as local midnight-relative, not as a UTC parse', () => {
    const { host, pill, updateBlock } = mountSheet()
    tap(pill)
    const input = control(host, 'Date') as HTMLInputElement
    input.value = '2026-12-24'
    input.dispatchEvent(new Event('change'))

    const written = updateBlock.mock.calls[0][1].content[0].props
    const local = new Date(written.dateISO)
    expect(local.getFullYear()).toBe(2026)
    expect(local.getMonth()).toBe(11)
    expect(local.getDate()).toBe(24)
    // The hour of the original instant is carried, exactly as desktop's
    // `handleDateSelect` carries it.
    expect(local.getHours()).toBe(new Date('2026-09-10T09:00:00.000Z').getHours())
  })

  it('reconciles the reminder when the time is switched off', () => {
    const { host, pill, updateBlock } = mountSheet({
      'data-has-time': 'true',
      'data-remind': '15m'
    })
    tap(pill)
    control(host, 'Include time').dispatchEvent(new Event('click', { bubbles: true }))
    const written = updateBlock.mock.calls[0][1].content[0].props
    expect(written.hasTime).toBe(false)
    expect(written.remind).toBe('at')
  })

  it('carries a desktop-set reminder through an unrelated edit', () => {
    // There is no Remind row on mobile; the value still has to survive.
    const { host, pill, updateBlock } = mountSheet({ 'data-remind': '1d' })
    tap(pill)
    control(host, 'Date format: Full date').dispatchEvent(new Event('click', { bubbles: true }))
    const written = updateBlock.mock.calls[0][1].content[0].props
    expect(written.dateFormat).toBe('full')
    expect(written.remind).toBe('1d')
  })

  it('removes the pill and closes', () => {
    const { controller, host, pill, updateBlock } = mountSheet()
    tap(pill)
    control(host, 'Remove date').dispatchEvent(new Event('click', { bubbles: true }))
    expect(updateBlock.mock.calls[0][1].content).toEqual([])
    expect(controller.isOpen()).toBe(false)
  })

  it('closes without writing when the dismiss chevron is pressed', () => {
    const { controller, host, pill, updateBlock } = mountSheet()
    tap(pill)
    control(host, 'Close date options').dispatchEvent(new Event('click', { bubbles: true }))
    expect(controller.isOpen()).toBe(false)
    expect(updateBlock).not.toHaveBeenCalled()
  })

  // One owner for the strip above the keyboard: the sheet stands in the
  // keyboard's space, so the two may never be on screen together.
  it('closes when the editor takes focus back, so the keyboard never shares the strip', () => {
    const { controller, host, root, pill, visibility } = mountSheet()
    tap(pill)
    expect(controller.isOpen()).toBe(true)
    // A tap on the note body: pointerdown lands off the pill, then the editor
    // focuses and the keyboard is on its way up.
    root.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    focusEditor(root)
    expect(controller.isOpen()).toBe(false)
    expect(host.hidden).toBe(true)
    expect(visibility).toHaveBeenLastCalledWith(false)
  })

  it('stays open when the focus is the pill tap that opened it', () => {
    const { controller, pill, root, visibility } = mountSheet()
    // WebKit may deliver the editor's focus on either side of `pointerup`, so
    // both orders have to survive. Before:
    pill.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
    focusEditor(root)
    pill.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }))
    expect(controller.isOpen()).toBe(true)
    // And after, on the same gesture.
    focusEditor(root)
    expect(controller.isOpen()).toBe(true)
    expect(visibility).toHaveBeenCalledTimes(1)
  })

  it('retargets rather than closing when a second pill is tapped', () => {
    const { controller, host, root, pill } = mountSheet()
    const other = pillElement({ 'data-anchor-id': 'dm_2', 'data-has-time': 'true' })
    root.append(other)
    tap(pill)
    expect(controller.isOpen()).toBe(true)
    tap(other)
    expect(controller.isOpen()).toBe(true)
    // The second pill carries a time, so its sheet grew the Time field.
    expect(host.querySelector('[aria-label="Time"]')).not.toBeNull()
  })

  it('stops closing on focus once destroyed', () => {
    const { controller, root, pill } = mountSheet()
    tap(pill)
    controller.destroy()
    expect(controller.isOpen()).toBe(false)
    // No listener left to throw on a surface the sheet no longer owns.
    expect(() => focusEditor(root)).not.toThrow()
  })

  it('will not open on a read-only note', () => {
    const { controller, pill } = mountSheet()
    controller.setReadOnly(true)
    tap(pill)
    expect(controller.isOpen()).toBe(false)
  })

  it('ignores a pill with no readable date', () => {
    const { controller, pill } = mountSheet({ 'data-date-iso': 'not-a-date' })
    tap(pill)
    expect(controller.isOpen()).toBe(false)
    expect(readDateMentionTarget(pill)).toBeNull()
  })
})
