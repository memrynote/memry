import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { VaultActivityChannels } from '@memry/contracts/vault-activity-api'

vi.mock('../lib/window-broadcast', () => ({
  broadcastToAllWindows: vi.fn()
}))

import { broadcastToAllWindows } from '../lib/window-broadcast'
import {
  closeActivityLog,
  clearActivity,
  createScanActivity,
  flushActivityLog,
  getActivityRetentionDays,
  isActivityLogOpen,
  listActivity,
  MAX_ACTIVITY_ENTRIES,
  openActivityLog,
  prepareActivityLogFile,
  recordActivity,
  recordDropCopyFailure,
  recordScanActivity,
  recordSkippedFile,
  setActivityRetentionDays,
  toActivityPath
} from './activity-log'

const DAY_MS = 86_400_000

describe('vault activity log', () => {
  let vaultPath: string
  let logPath: string

  function readLogLines(): Record<string, unknown>[] {
    if (!fs.existsSync(logPath)) return []
    return fs
      .readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  function writeLogLines(lines: unknown[]): void {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.writeFileSync(
      logPath,
      lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') +
        '\n'
    )
  }

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-activity-'))
    fs.mkdirSync(path.join(vaultPath, '.memry'))
    logPath = path.join(vaultPath, '.memry', 'activity.jsonl')
  })

  afterEach(async () => {
    await closeActivityLog()
    fs.rmSync(vaultPath, { recursive: true, force: true })
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('records nothing while no vault is open', () => {
    expect(recordActivity({ kind: 'added', source: 'watcher', path: 'a.md' })).toBe(false)
    expect(listActivity()).toEqual([])
  })

  it('appends entries to .memry/activity.jsonl and lists them newest first', async () => {
    openActivityLog(vaultPath)
    recordActivity({ kind: 'added', source: 'watcher', path: 'notes/a.md' })
    recordActivity({ kind: 'removed', source: 'watcher', path: 'notes/b.md' })
    await flushActivityLog()

    const lines = readLogLines()
    expect(lines.map((line) => [line.kind, line.path])).toEqual([
      ['added', 'notes/a.md'],
      ['removed', 'notes/b.md']
    ])
    expect(lines[0]).toMatchObject({ v: 1, source: 'watcher' })
    expect(typeof lines[0].id).toBe('string')
    expect(typeof lines[0].at).toBe('string')

    expect(listActivity().map((entry) => entry.path)).toEqual(['notes/b.md', 'notes/a.md'])
  })

  it('reloads the log when the vault is reopened', async () => {
    openActivityLog(vaultPath)
    recordActivity({ kind: 'added', source: 'scan', path: 'x.pdf' })
    await closeActivityLog()

    openActivityLog(vaultPath)
    expect(listActivity().map((entry) => entry.path)).toEqual(['x.pdf'])
  })

  it('drops unreadable lines and entries past the retention window, then compacts', async () => {
    const now = Date.now()
    writeLogLines([
      {
        v: 1,
        id: 'old',
        at: new Date(now - 40 * DAY_MS).toISOString(),
        kind: 'added',
        source: 'watcher',
        path: 'old.md'
      },
      'not json',
      {
        v: 1,
        id: 'future-kind',
        at: new Date(now).toISOString(),
        kind: 'teleported',
        source: 'watcher'
      },
      {
        v: 1,
        id: 'recent',
        at: new Date(now - DAY_MS).toISOString(),
        kind: 'added',
        source: 'watcher',
        path: 'recent.md'
      }
    ])

    openActivityLog(vaultPath)
    expect(listActivity().map((entry) => entry.id)).toEqual(['recent'])

    await flushActivityLog()
    expect(readLogLines().map((line) => line.id)).toEqual(['recent'])
  })

  it('reports an unsupported file once, and never canvases or editor lock files', async () => {
    openActivityLog(vaultPath)
    expect(recordSkippedFile('docs/report.docx', 'watcher')).toBe(true)
    expect(recordSkippedFile('docs/report.docx', 'scan')).toBe(false)
    expect(recordSkippedFile('canvases/Board.excalidraw', 'watcher')).toBe(false)
    expect(recordSkippedFile('docs/~$report.docx', 'watcher')).toBe(false)
    expect(recordSkippedFile('downloads/file.pdf.crdownload', 'watcher')).toBe(false)

    const [entry] = listActivity()
    expect(entry).toMatchObject({
      kind: 'skipped',
      reason: 'unsupported-type',
      path: 'docs/report.docx',
      message: '.docx'
    })

    // The dedupe survives a relaunch: it is rebuilt from the retained entries.
    await closeActivityLog()
    openActivityLog(vaultPath)
    expect(recordSkippedFile('docs/report.docx', 'scan')).toBe(false)
  })

  it('drops a repeat with the same dedupe key inside its window', () => {
    vi.useFakeTimers()
    openActivityLog(vaultPath)
    const input = {
      kind: 'failed' as const,
      source: 'sync' as const,
      reason: 'note-too-large',
      dedupeKey: 'note-too-large:Big',
      dedupeWindowMs: 60_000
    }
    expect(recordActivity(input)).toBe(true)
    expect(recordActivity(input)).toBe(false)
    vi.advanceTimersByTime(60_001)
    expect(recordActivity(input)).toBe(true)
    expect(listActivity()).toHaveLength(2)
  })

  it('filters to problems', () => {
    openActivityLog(vaultPath)
    recordActivity({ kind: 'added', source: 'watcher', path: 'a.md' })
    recordActivity({ kind: 'failed', source: 'drop', path: 'b.md', reason: 'copy-failed' })
    recordActivity({
      kind: 'import',
      source: 'import',
      importer: 'notion',
      counts: { imported: 3 }
    })
    recordActivity({
      kind: 'import',
      source: 'import',
      importer: 'bear',
      counts: { imported: 1, skipped: 2 }
    })

    expect(
      listActivity({ filter: 'problems' }).map((entry) => entry.path ?? entry.importer)
    ).toEqual(['bear', 'b.md'])
  })

  it('broadcasts a throttled change event', () => {
    vi.useFakeTimers()
    openActivityLog(vaultPath)
    recordActivity({ kind: 'added', source: 'watcher', path: 'a.md' })
    recordActivity({ kind: 'added', source: 'watcher', path: 'b.md' })
    vi.advanceTimersByTime(1000)
    expect(broadcastToAllWindows).toHaveBeenCalledTimes(1)
    expect(broadcastToAllWindows).toHaveBeenCalledWith(VaultActivityChannels.events.CHANGED)
  })

  it('clears every entry on disk and in memory', async () => {
    openActivityLog(vaultPath)
    recordActivity({ kind: 'added', source: 'watcher', path: 'a.md' })
    recordSkippedFile('b.docx', 'watcher')
    await clearActivity()

    expect(listActivity()).toEqual([])
    expect(readLogLines()).toEqual([])
    // A cleared skip is reported again the next time the file is seen.
    expect(recordSkippedFile('b.docx', 'scan')).toBe(true)
  })

  it('persists retention and prunes to it', async () => {
    openActivityLog(vaultPath)
    expect(getActivityRetentionDays()).toBe(30)
    await setActivityRetentionDays(7)

    const settings = JSON.parse(
      fs.readFileSync(path.join(vaultPath, '.memry', 'activity-settings.json'), 'utf-8')
    ) as { retentionDays: number }
    expect(settings.retentionDays).toBe(7)

    await closeActivityLog()
    const now = Date.now()
    writeLogLines([
      {
        v: 1,
        id: 'eight-days',
        at: new Date(now - 8 * DAY_MS).toISOString(),
        kind: 'added',
        source: 'watcher'
      },
      {
        v: 1,
        id: 'six-days',
        at: new Date(now - 6 * DAY_MS).toISOString(),
        kind: 'added',
        source: 'watcher'
      }
    ])
    openActivityLog(vaultPath)
    expect(getActivityRetentionDays()).toBe(7)
    expect(listActivity().map((entry) => entry.id)).toEqual(['six-days'])
  })

  it('creates the log file on demand so it can be revealed', async () => {
    openActivityLog(vaultPath)
    expect(fs.existsSync(logPath)).toBe(false)
    expect(await prepareActivityLogFile()).toBe(logPath)
    expect(fs.existsSync(logPath)).toBe(true)
  })

  it('maps absolute paths to vault-relative ones', () => {
    openActivityLog(vaultPath)
    expect(toActivityPath(path.join(vaultPath, 'notes', 'a.pdf'))).toBe('notes/a.pdf')
    expect(toActivityPath(path.join(os.tmpdir(), 'elsewhere', 'b.pdf'))).toBe('b.pdf')
  })

  it('does nothing to the log helpers while no vault is open', async () => {
    expect(isActivityLogOpen()).toBe(false)
    expect(await prepareActivityLogFile()).toBeNull()
    await setActivityRetentionDays(7)
    await clearActivity()
    expect(recordSkippedFile('a.docx', 'watcher')).toBe(false)
    expect(toActivityPath('notes\\a.md')).toBe('notes/a.md')
  })

  it('switches to another vault without mixing their entries', async () => {
    openActivityLog(vaultPath)
    recordActivity({ kind: 'added', source: 'watcher', path: 'first.md' })
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-activity-other-'))
    try {
      openActivityLog(other)
      expect(listActivity()).toEqual([])
      await closeActivityLog()
      openActivityLog(vaultPath)
      expect(listActivity().map((entry) => entry.path)).toEqual(['first.md'])
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })

  it('bounds long messages and item lists, and drops undefined fields', () => {
    openActivityLog(vaultPath)
    recordActivity({
      kind: 'import',
      source: 'import',
      message: 'x'.repeat(2000),
      items: Array.from({ length: 80 }, (_, i) => `item ${i}`),
      path: undefined
    })
    const [entry] = listActivity()
    expect(entry.message?.length).toBeLessThan(600)
    expect(entry.items).toHaveLength(50)
    expect(entry).not.toHaveProperty('path')
  })

  it('records a sidebar drop that could not be copied', () => {
    openActivityLog(vaultPath)
    recordDropCopyFailure('report.pdf', 'EACCES')
    expect(listActivity()[0]).toMatchObject({
      kind: 'failed',
      source: 'drop',
      path: 'report.pdf',
      reason: 'copy-failed',
      message: 'EACCES'
    })
  })

  it('compacts the log once it grows well past the entry cap', async () => {
    openActivityLog(vaultPath)
    for (let i = 0; i < MAX_ACTIVITY_ENTRIES + 501; i++) {
      recordActivity({ kind: 'added', source: 'watcher', path: `n${i}.md` })
    }
    expect(listActivity({ limit: 1000 })).toHaveLength(1000)
    await flushActivityLog()
    const lines = readLogLines()
    expect(lines).toHaveLength(MAX_ACTIVITY_ENTRIES)
    expect(lines.at(-1)?.path).toBe(`n${MAX_ACTIVITY_ENTRIES + 500}.md`)
  })

  it('keeps recording in memory when the file cannot be written', async () => {
    fs.mkdirSync(logPath)
    openActivityLog(vaultPath)
    recordActivity({ kind: 'added', source: 'watcher', path: 'a.md' })
    await expect(flushActivityLog()).resolves.toBeUndefined()
    expect(listActivity()).toHaveLength(1)
  })

  it('prunes the open log when retention shrinks', async () => {
    const now = Date.now()
    writeLogLines([
      {
        v: 1,
        id: 'twenty-days',
        at: new Date(now - 20 * DAY_MS).toISOString(),
        kind: 'skipped',
        source: 'scan',
        path: 'old.docx',
        reason: 'unsupported-type'
      },
      { v: 1, id: 'today', at: new Date(now).toISOString(), kind: 'added', source: 'watcher' }
    ])
    openActivityLog(vaultPath)
    expect(listActivity()).toHaveLength(2)

    await setActivityRetentionDays(7)
    await flushActivityLog()

    expect(listActivity().map((entry) => entry.id)).toEqual(['today'])
    expect(readLogLines().map((line) => line.id)).toEqual(['today'])
    // The pruned skip may be reported again.
    expect(recordSkippedFile('old.docx', 'scan')).toBe(true)
  })

  describe('recordScanActivity', () => {
    it('records a small scan file by file', () => {
      openActivityLog(vaultPath)
      const scan = createScanActivity()
      scan.added.push('notes/new.md')
      scan.addedCount = 1
      scan.failed.push({ path: 'notes/broken.md', reason: 'read-failed', message: 'EACCES' })
      scan.failedCount = 1
      scan.unsupported.push('notes/sheet.xlsx', 'canvases/Board.excalidraw')
      scan.unsupportedCount = 2

      recordScanActivity(scan, 'scan')

      expect(
        listActivity()
          .map((entry) => `${entry.kind}:${entry.path ?? ''}`)
          .sort()
      ).toEqual(['added:notes/new.md', 'failed:notes/broken.md', 'skipped:notes/sheet.xlsx'])
    })

    it('summarizes a scan with many new files instead of listing each', () => {
      openActivityLog(vaultPath)
      const scan = createScanActivity()
      for (let i = 0; i < 30; i++) scan.added.push(`notes/${i}.md`)
      scan.addedCount = 30

      recordScanActivity(scan, 'scan')

      const entries = listActivity()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ kind: 'scan', counts: { added: 30 } })
      expect(entries[0].items).toHaveLength(30)
    })

    it('records a rebuild as one summary without per-file adds', () => {
      openActivityLog(vaultPath)
      const scan = createScanActivity()
      scan.added.push('a.md', 'b.md')
      scan.addedCount = 2

      recordScanActivity(scan, 'rebuild')

      const entries = listActivity()
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        kind: 'scan',
        reason: 'index-rebuilt',
        counts: { added: 2 }
      })
    })

    it('records nothing when the scan found nothing new', () => {
      openActivityLog(vaultPath)
      recordSkippedFile('old.docx', 'watcher')
      const scan = createScanActivity()
      scan.unsupported.push('old.docx')
      scan.unsupportedCount = 1

      recordScanActivity(scan, 'scan')

      expect(listActivity()).toHaveLength(1)
    })
  })
})
