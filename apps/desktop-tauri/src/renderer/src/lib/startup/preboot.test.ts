import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `public/preboot.html`, `public/preboot.js` and the main window's localStorage import script
// ship as they are, outside the bundle, so the tests load the files the app loads.
const appRoot = join(import.meta.dirname, '../../../../..')
const read = (path: string): string => readFileSync(join(appRoot, path), 'utf8')
const PAGE = read('src/renderer/public/preboot.html')
const SCRIPT = read('src/renderer/public/preboot.js')
const IMPORT = read('src-tauri/src/windows/scripts/local-storage-import.js')

type Invoke = ReturnType<typeof vi.fn<(command: string) => Promise<unknown>>>
interface TestWindow {
  __TAURI_INTERNALS__?: { invoke: Invoke }
  memryMigration?: { start: () => void; update: (status: unknown) => void }
}
const testWindow = window as unknown as TestWindow

function status(seq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq,
    state: 'running',
    percent: 20,
    title: 'Moving your data',
    phase: 'Moving vault 1 of 2…',
    body: 'This happens once.',
    note: null,
    check: null,
    checkLine: null,
    details: null,
    ...overrides
  }
}

const FAILED = {
  state: 'failed',
  percent: 0,
  title: "Your data wasn't moved",
  phase: null,
  body: 'There isn’t enough free disk space.',
  note: 'Nothing was lost.',
  check: 'disk-space',
  checkLine: 'Failed check: disk-space',
  details: 'need 3 GB, have 1 GB'
}

function loadPage(view: string, invoke: Invoke): void {
  const parsed = new DOMParser().parseFromString(PAGE, 'text/html')
  parsed.querySelectorAll('script').forEach((script) => script.remove())
  document.body.innerHTML = parsed.body.innerHTML
  document.documentElement.dataset.view = view
  testWindow.__TAURI_INTERNALS__ = { invoke }
  new Function(SCRIPT)()
}

const slot = (name: string): HTMLElement =>
  document.querySelector<HTMLElement>(`.migration [data-slot='${name}']`)!
const bar = (): HTMLElement => document.querySelector<HTMLElement>('.migration .bar')!
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  delete testWindow.__TAURI_INTERNALS__
  delete testWindow.memryMigration
  delete document.documentElement.dataset.view
  delete document.documentElement.dataset.state
  document.body.innerHTML = ''
})

describe('migration view', () => {
  it('shows the status migration_status returns', async () => {
    const invoke = vi.fn(async () => status(2, { percent: 43 }))
    loadPage('migration', invoke)
    testWindow.memryMigration!.start()
    await flush()

    expect(invoke).toHaveBeenCalledWith('migration_status')
    expect(slot('title').textContent).toBe('Moving your data')
    expect(slot('phase').textContent).toBe('Moving vault 1 of 2…')
    expect(slot('phase').hidden).toBe(false)
    expect(bar().getAttribute('aria-valuenow')).toBe('43')
    expect(bar().querySelector<HTMLElement>('.fill')!.style.inlineSize).toBe('43%')
    expect(document.documentElement.dataset.state).toBe('running')
  })

  it('drops a status older than an update already shown', async () => {
    let answer: (value: unknown) => void = () => {}
    const invoke = vi.fn(() => new Promise((resolve) => (answer = resolve)))
    loadPage('migration', invoke)
    testWindow.memryMigration!.start()
    testWindow.memryMigration!.update(status(5, { percent: 66 }))
    answer(status(3, { percent: 20 }))
    await flush()

    expect(bar().getAttribute('aria-valuenow')).toBe('66')
  })

  it('writes every string as text, never as markup', () => {
    loadPage('migration', vi.fn())
    testWindow.memryMigration!.update(
      status(1, { ...FAILED, details: '<img src=x onerror=alert(1)>' })
    )
    expect(slot('details').textContent).toBe('<img src=x onerror=alert(1)>')
    expect(slot('details').querySelector('img')).toBeNull()
  })

  it('names the failing check and moves focus to Try again', () => {
    loadPage('migration', vi.fn())
    testWindow.memryMigration!.update(status(1, FAILED))

    expect(document.documentElement.dataset.state).toBe('failed')
    expect(slot('check-line').textContent).toBe('Failed check: disk-space')
    expect(slot('details').textContent).toBe('need 3 GB, have 1 GB')
    expect(slot('note').hidden).toBe(false)
    expect(slot('phase').hidden).toBe(true)
    expect(slot('retry')).not.toBeDisabled()
    expect(document.activeElement).toBe(slot('retry'))
    expect(slot('details').getAttribute('dir')).toBe('ltr')
  })

  it('Try again calls migration_retry and disables the actions until the run reports', async () => {
    const invoke = vi.fn(async () => undefined)
    loadPage('migration', invoke)
    testWindow.memryMigration!.update(status(1, FAILED))
    slot('retry').click()
    await flush()

    expect(invoke).toHaveBeenCalledWith('migration_retry')
    expect(slot('retry')).toBeDisabled()
    expect(slot('show-details')).toBeDisabled()
    testWindow.memryMigration!.update(status(2))
    expect(slot('retry')).toBeDisabled()
    expect(slot('check-line').hidden).toBe(true)
  })

  it('a refused Try again gives the actions back', async () => {
    const invoke = vi.fn(async () => Promise.reject(new Error('migration_not_failed')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    loadPage('migration', invoke)
    testWindow.memryMigration!.update(status(1, FAILED))
    slot('retry').click()
    await flush()

    expect(slot('retry')).not.toBeDisabled()
  })

  it('Show details says so when there is no report', async () => {
    const invoke = vi.fn(async () =>
      Promise.reject({ kind: 'notFound', code: 'migration_report_missing' })
    )
    loadPage('migration', invoke)
    testWindow.memryMigration!.update(status(1, FAILED))
    expect(slot('report-missing').hidden).toBe(true)
    slot('show-details').click()
    await flush()

    expect(invoke).toHaveBeenCalledWith('migration_open_report')
    expect(slot('report-missing').hidden).toBe(false)
  })

  it('the startup-error page invokes nothing', async () => {
    const invoke = vi.fn(async () => status(1))
    loadPage('error', invoke)
    await flush()

    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('localStorage import script', () => {
  const run = (entries: Record<string, string>): void =>
    new Function(IMPORT.replace('__MEMRY_ENTRIES__', JSON.stringify(entries)))()

  beforeEach(() => window.localStorage.clear())

  it('sets only the keys this origin lacks, then marks the file applied', async () => {
    const invoke = vi.fn(async () => undefined)
    testWindow.__TAURI_INTERNALS__ = { invoke }
    window.localStorage.setItem('memry-theme', 'dark')
    run({ 'memry-theme': 'light', 'memry-zoom': '1.1' })
    await flush()

    expect(window.localStorage.getItem('memry-theme')).toBe('dark')
    expect(window.localStorage.getItem('memry-zoom')).toBe('1.1')
    expect(invoke).toHaveBeenCalledWith('migration_localstorage_applied')
  })

  it('a second run changes nothing', () => {
    testWindow.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => undefined) }
    run({ 'memry-zoom': '1.1' })
    window.localStorage.setItem('memry-zoom', '1.3')
    run({ 'memry-zoom': '1.1' })

    expect(window.localStorage.getItem('memry-zoom')).toBe('1.3')
  })

  it('a failed write leaves the file pending', () => {
    const invoke = vi.fn(async () => undefined)
    testWindow.__TAURI_INTERNALS__ = { invoke }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    run({ 'memry-zoom': '1.1' })

    expect(invoke).not.toHaveBeenCalled()
  })
})

afterEach(() => vi.restoreAllMocks())
