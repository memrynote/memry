import { describe, expect, it } from 'vitest'
import { ExtensionCaptureEnvelopeSchema } from './extension-capture-api'

describe('ExtensionCaptureEnvelopeSchema', () => {
  it('accepts a saved link capture with optional source metadata', () => {
    const result = ExtensionCaptureEnvelopeSchema.safeParse({
      schemaVersion: 1,
      capturedAt: '2026-05-13T09:59:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'link',
        url: 'https://example.com/post',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example',
        tags: ['read-later']
      }
    })

    expect(result.success).toBe(true)
  })

  it('accepts a highlighted quote capture from Chrome', () => {
    const result = ExtensionCaptureEnvelopeSchema.safeParse({
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:00:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'clip',
        html: '<blockquote>ship smaller pieces</blockquote>',
        text: 'ship smaller pieces',
        sourceUrl: 'https://example.com/post',
        sourceTitle: 'Example Post'
      }
    })

    expect(result.success).toBe(true)
  })

  it('accepts a full-page capture from Chrome', () => {
    const result = ExtensionCaptureEnvelopeSchema.safeParse({
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:00:30.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'page',
        html: '<main>page body</main>',
        text: 'page body',
        sourceUrl: 'https://example.com/page',
        sourceTitle: 'Example Page'
      }
    })

    expect(result.success).toBe(true)
  })

  it('accepts binary file captures as base64 for image, audio, video, and pdf inbox items', () => {
    const result = ExtensionCaptureEnvelopeSchema.safeParse({
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:01:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'file',
        dataBase64: Buffer.from('%PDF-1.7').toString('base64'),
        filename: 'paper.pdf',
        mimeType: 'application/pdf',
        sourceUrl: 'https://example.com/paper.pdf',
        sourceTitle: 'Paper'
      }
    })

    expect(result.success).toBe(true)
  })

  it('rejects unsupported file capture MIME types', () => {
    const result = ExtensionCaptureEnvelopeSchema.safeParse({
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:01:30.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'file',
        dataBase64: Buffer.from('hello').toString('base64'),
        filename: 'notes.txt',
        mimeType: 'text/plain'
      }
    })

    expect(result.success).toBe(false)
  })

  it('rejects envelopes that do not come from the local Chrome extension bridge', () => {
    const result = ExtensionCaptureEnvelopeSchema.safeParse({
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:02:00.000Z',
      source: 'cloud',
      capture: {
        kind: 'link',
        url: 'https://example.com'
      }
    })

    expect(result.success).toBe(false)
  })
})
