import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stripTimestamp = (line: string): string => line.slice('2026-10-01 14:24:40.000 '.length)

describe('main.log file transport', () => {
  let dir: string

  beforeEach(() => {
    vi.resetModules()
    dir = mkdtempSync(join(tmpdir(), 'memry-log-'))
    process.env.MEMRY_TEST_LOG_DIR = dir
  })

  afterEach(() => {
    delete process.env.MEMRY_TEST_LOG_DIR
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const loadLogger = async (): Promise<typeof import('./logger')> => {
    const logger = await import('./logger')
    logger.log.transports.console.level = false
    logger.log.transports.file.level = 'debug'
    return logger
  }

  const readLines = (name: string): string[] =>
    readFileSync(join(dir, name), 'utf8').trimEnd().split(/\r?\n/)

  // AF-014: one error repeated 20,219 times filled the file in minutes.
  it('writes a run of identical lines once, then its count stamped with the last repeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 1, 14, 24, 40))
    const { createLogger } = await loadLogger()
    const log = createLogger('Flood')

    for (let i = 0; i < 500; i++) {
      log.error('Failed to push', { noteId: 'note-a' })
      vi.advanceTimersByTime(1000)
    }
    log.error('Failed to push', { noteId: 'note-b' })
    log.info('Signed in')

    const lines = readLines('main.log')
    expect(
      lines.map(stripTimestamp).map((line) => line.replace(/\[\s*\(?Flood\)?\s*\]/, '[Flood]'))
    ).toEqual([
      "[error] [Flood] Failed to push { noteId: 'note-a' }",
      '[error] [Flood] Previous line repeated 499 more times, the last at this time',
      "[error] [Flood] Failed to push { noteId: 'note-b' }",
      '[info]  [Flood] Signed in'
    ])
    expect(lines[1].startsWith('2026-10-01 14:32:59.000 ')).toBe(true)
  })

  it('keeps four archives and rotates without a gap in the history', async () => {
    const { log, createLogger } = await loadLogger()
    log.transports.file.maxSize = 2000
    const logger = createLogger('Rotate')

    const total = 600
    for (let i = 0; i < total; i++) logger.info(`line ${i}`)

    expect(readdirSync(dir).sort()).toEqual([
      'main.1.log',
      'main.2.log',
      'main.3.log',
      'main.4.log',
      'main.log'
    ])
    const kept = ['main.4.log', 'main.3.log', 'main.2.log', 'main.1.log', 'main.log']
      .flatMap(readLines)
      .map((line) => Number(/line (\d+)$/.exec(line)?.[1]))
    const first = kept[0]
    expect(first).toBeGreaterThan(0)
    expect(kept).toEqual(Array.from({ length: total - first }, (_, i) => first + i))
  })
})
