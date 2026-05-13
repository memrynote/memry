import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
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

import { importPendingCaptureHandoff } from './importer'

function writeCapture(dir: string, name: string, capture: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(capture), 'utf8')
  return path
}

describe('importPendingCaptureHandoff', () => {
  let captureDir: string

  beforeEach(() => {
    captureDir = mkdtempSync(join(tmpdir(), 'memry-capture-import-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
})
