import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/memry')
  }
}))

vi.mock('../vault', () => ({
  getStatus: vi.fn(() => ({ isOpen: true }))
}))

vi.mock('../inbox/domain', () => ({
  createDesktopInboxDomain: vi.fn(() => ({}))
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import {
  importPendingCaptureHandoff,
  startCaptureHandoffWatcher,
  stopCaptureHandoffWatcher
} from './importer'

function writeCapture(dir: string, name: string, capture: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(capture), 'utf8')
  return path
}

describe('importPendingCaptureHandoff', () => {
  let captureRoot: string
  let captureDir: string

  beforeEach(() => {
    captureRoot = mkdtempSync(join(tmpdir(), 'memry-capture-import-'))
    captureDir = join(captureRoot, 'pending')
    mkdirSync(captureDir, { recursive: true })
  })

  afterEach(() => {
    stopCaptureHandoffWatcher()
    rmSync(captureRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps pending captures on disk when no vault is open', async () => {
    const filePath = writeCapture(captureDir, 'clip.json', {
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:00:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'clip',
        text: 'quoted text',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example'
      }
    })
    const captureClip = vi.fn()

    const result = await importPendingCaptureHandoff({
      captureDir,
      isVaultOpen: () => false,
      domain: { captureClip }
    })

    expect(result).toEqual({ imported: 0, failed: 0, skipped: true })
    expect(captureClip).not.toHaveBeenCalled()
    expect(existsSync(filePath)).toBe(true)
  })

  it('returns without work when the capture handoff directory does not exist', async () => {
    const result = await importPendingCaptureHandoff({
      captureDir: join(captureRoot, 'missing'),
      isVaultOpen: () => true,
      domain: { captureClip: vi.fn() }
    })

    expect(result).toEqual({ imported: 0, failed: 0, skipped: false })
  })

  it('imports highlighted text as a browser-extension clip and removes the handoff file', async () => {
    const filePath = writeCapture(captureDir, 'clip.json', {
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:00:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'clip',
        html: '<p>quoted text</p>',
        text: 'quoted text',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example'
      }
    })
    const captureClip = vi.fn(async () => ({ success: true, item: { id: 'clip-1' } }))

    const result = await importPendingCaptureHandoff({
      captureDir,
      isVaultOpen: () => true,
      domain: { captureClip }
    })

    expect(result).toEqual({ imported: 1, failed: 0, skipped: false })
    expect(captureClip).toHaveBeenCalledWith({
      html: '<p>quoted text</p>',
      text: 'quoted text',
      sourceUrl: 'https://example.com',
      sourceTitle: 'Example',
      source: 'browser-extension'
    })
    expect(existsSync(filePath)).toBe(false)
  })

  it('routes page and link captures through the matching inbox capture methods', async () => {
    writeCapture(captureDir, '01-link.json', {
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:00:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'link',
        url: 'https://example.com/post',
        tags: ['research']
      }
    })
    writeCapture(captureDir, '02-page.json', {
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:00:01.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'page',
        html: '<main>saved page</main>',
        text: 'saved page',
        sourceUrl: 'https://example.com/page',
        sourceTitle: 'Saved Page',
        tags: ['read-later']
      }
    })
    const captureLink = vi.fn(async () => ({ success: true, item: { id: 'link-1' } }))
    const captureClip = vi.fn(async () => ({ success: true, item: { id: 'page-1' } }))

    const result = await importPendingCaptureHandoff({
      captureDir,
      isVaultOpen: () => true,
      domain: { captureLink, captureClip }
    })

    expect(result).toEqual({ imported: 2, failed: 0, skipped: false })
    expect(captureLink).toHaveBeenCalledWith({
      url: 'https://example.com/post',
      tags: ['research'],
      source: 'browser-extension'
    })
    expect(captureClip).toHaveBeenCalledWith({
      html: '<main>saved page</main>',
      text: 'saved page',
      sourceUrl: 'https://example.com/page',
      sourceTitle: 'Saved Page',
      tags: ['read-later'],
      source: 'browser-extension'
    })
  })

  it('imports binary captures as inbox attachments with source metadata', async () => {
    writeCapture(captureDir, 'file.json', {
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:01:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'file',
        dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
        filename: 'diagram.png',
        mimeType: 'image/png',
        sourceUrl: 'https://example.com/diagram.png',
        sourceTitle: 'Diagram'
      }
    })
    const captureImage = vi.fn(async () => ({ success: true, item: { id: 'image-1' } }))

    await importPendingCaptureHandoff({
      captureDir,
      isVaultOpen: () => true,
      domain: { captureImage }
    })

    expect(captureImage).toHaveBeenCalledWith({
      data: Buffer.from([1, 2, 3]),
      filename: 'diagram.png',
      mimeType: 'image/png',
      tags: undefined,
      source: 'browser-extension'
    })
  })

  it('moves invalid capture handoffs aside instead of retrying them forever', async () => {
    const filePath = writeCapture(captureDir, 'bad.json', {
      schemaVersion: 1,
      capturedAt: 'not-a-date',
      source: 'chrome-extension',
      capture: {
        kind: 'link',
        url: 'https://example.com'
      }
    })

    const result = await importPendingCaptureHandoff({
      captureDir,
      isVaultOpen: () => true,
      domain: {}
    })

    expect(result).toEqual({ imported: 0, failed: 1, skipped: false })
    expect(existsSync(filePath)).toBe(false)
    expect(readdirSync(join(captureRoot, 'failed'))[0]).toContain('bad.json')
  })

  it('keeps valid capture handoffs pending when the inbox import fails', async () => {
    const filePath = writeCapture(captureDir, 'retry-link.json', {
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:03:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'link',
        url: 'https://example.com/retry'
      }
    })
    const captureLink = vi.fn(async () => ({ success: false, error: 'Vault write failed' }))

    const result = await importPendingCaptureHandoff({
      captureDir,
      isVaultOpen: () => true,
      domain: { captureLink }
    })

    expect(result).toEqual({ imported: 0, failed: 1, skipped: false })
    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(join(captureRoot, 'failed'))).toBe(false)
  })

  it('starts one capture watcher and stops it cleanly', async () => {
    vi.useFakeTimers()

    startCaptureHandoffWatcher()
    startCaptureHandoffWatcher()

    expect(vi.getTimerCount()).toBe(1)

    stopCaptureHandoffWatcher()
    stopCaptureHandoffWatcher()
    await Promise.resolve()

    expect(vi.getTimerCount()).toBe(0)
  })
})
