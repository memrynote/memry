import { expect, type ElectronApplication, type Page } from '@playwright/test'
import { normalizeBodyText } from './note-sync-helpers'

export interface NoteOnDeviceStatus {
  recordPresent: boolean
  crdtPresent: boolean
  crdtBody: string | null
}

interface MemryWaitTestHooks {
  hasNoteOnDevice(noteId: string): Promise<NoteOnDeviceStatus>
}

/**
 * Raw (non-polling) probe. Returns the current record + CRDT state for a
 * noteId on the given device. Body is normalized so comparisons match the
 * note-sync-helpers conventions.
 */
export async function readNoteOnDevice(
  electronApp: ElectronApplication,
  noteId: string
): Promise<NoteOnDeviceStatus> {
  const status = await electronApp.evaluate(async (_ctx, id) => {
    const hooks = (
      globalThis as typeof globalThis & {
        __memryTestHooks?: MemryWaitTestHooks
      }
    ).__memryTestHooks
    if (!hooks) {
      throw new Error('Memry test hooks are not registered')
    }
    return hooks.hasNoteOnDevice(id)
  }, noteId)

  return {
    recordPresent: status.recordPresent,
    crdtPresent: status.crdtPresent,
    crdtBody: status.crdtBody == null ? null : normalizeBodyText(status.crdtBody)
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const DEFAULT_WAIT_INTERVALS = [250, 500, 1_000, 2_000] as const

export async function getVisibleDayStart(page: Page): Promise<number> {
  const value = await page.getByTestId('calendar-view').getAttribute('data-visible-day-start')
  if (value == null) {
    throw new Error('calendar-view is missing data-visible-day-start attribute')
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`data-visible-day-start is not numeric: ${value}`)
  }
  return parsed
}

export async function getAnchorDate(page: Page): Promise<string> {
  const value = await page.getByTestId('calendar-view').getAttribute('data-anchor-date')
  if (value == null) {
    throw new Error('calendar-view is missing data-anchor-date attribute')
  }
  return value
}

export async function waitForAnchorDate(
  page: Page,
  expected: string,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_WAIT_TIMEOUT_MS
  await expect(page.getByTestId('calendar-view')).toHaveAttribute('data-anchor-date', expected, {
    timeout
  })
}

export async function waitForNoteReplicated(
  electronApp: ElectronApplication,
  noteId: string,
  expectedBody: string,
  opts: { timeout?: number } = {}
): Promise<void> {
  const timeout = opts.timeout ?? 90_000
  const normalizedExpected = normalizeBodyText(expectedBody)
  await expect
    .poll(() => readNoteOnDevice(electronApp, noteId), {
      timeout,
      intervals: [...DEFAULT_WAIT_INTERVALS]
    })
    .toEqual({
      recordPresent: true,
      crdtPresent: true,
      crdtBody: normalizedExpected
    })
}

export async function waitForStable<T>(
  read: () => Promise<T>,
  opts: {
    stableFor: number
    timeout: number
    equals?: (a: T, b: T) => boolean
  }
): Promise<T> {
  const equals = opts.equals ?? ((a, b) => Object.is(a, b))
  const pollInterval = 50
  const deadline = Date.now() + opts.timeout
  let previous = await read()
  let stableSince = Date.now()

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval))
    const current = await read()
    if (equals(previous, current)) {
      if (Date.now() - stableSince >= opts.stableFor) {
        return current
      }
    } else {
      previous = current
      stableSince = Date.now()
    }
  }

  throw new Error(
    `waitForStable: value did not remain stable for ${opts.stableFor}ms within ${opts.timeout}ms`
  )
}
