import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createClipCapture,
  createEnvelope,
  createFileCapture,
  createLinkCapture,
  createPageCapture,
  filenameFromUrl,
  isProbablyFileUrl
} from './capture.js'

test('createEnvelope marks every capture as local Chrome extension input', () => {
  const envelope = createEnvelope(
    createLinkCapture({ url: 'https://example.com', sourceTitle: 'Example' }),
    new Date('2026-05-13T10:00:00.000Z')
  )

  assert.equal(envelope.schemaVersion, 1)
  assert.equal(envelope.source, 'chrome-extension')
  assert.equal(envelope.capturedAt, '2026-05-13T10:00:00.000Z')
  assert.equal(envelope.capture.kind, 'link')
})

test('createClipCapture keeps selected quote context for Memry inbox clips', () => {
  const capture = createClipCapture({
    text: 'quoted text',
    html: '<p>quoted text</p>',
    sourceUrl: 'https://example.com/article',
    sourceTitle: 'Article'
  })

  assert.deepEqual(capture, {
    kind: 'clip',
    text: 'quoted text',
    html: '<p>quoted text</p>',
    sourceUrl: 'https://example.com/article',
    sourceTitle: 'Article'
  })
})

test('createFileCapture carries binary data as base64 for native messaging', () => {
  const capture = createFileCapture({
    dataBase64: Buffer.from([1, 2, 3]).toString('base64'),
    filename: 'diagram.png',
    mimeType: 'image/png',
    sourceUrl: 'https://example.com/diagram.png',
    sourceTitle: 'Diagram'
  })

  assert.equal(capture.kind, 'file')
  assert.equal(capture.filename, 'diagram.png')
  assert.equal(capture.mimeType, 'image/png')
})

test('filenameFromUrl and isProbablyFileUrl detect supported files', () => {
  assert.equal(filenameFromUrl('https://example.com/files/paper.pdf?download=1'), 'paper.pdf')
  assert.equal(isProbablyFileUrl('https://example.com/files/paper.pdf?download=1'), true)
  assert.equal(isProbablyFileUrl('https://example.com/read'), false)
})

test('createPageCapture truncates large pages to the handoff contract limits', () => {
  const capture = createPageCapture({
    text: 't'.repeat(50001),
    html: '<main>' + 'h'.repeat(100000) + '</main>',
    sourceUrl: 'https://example.com/' + 'u'.repeat(2500),
    sourceTitle: 's'.repeat(250)
  })

  assert.equal(capture.text.length, 50000)
  assert.equal(capture.html.length, 100000)
  assert.equal(capture.sourceUrl.length, 2000)
  assert.equal(capture.sourceTitle.length, 200)
})
