import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  getPendingCaptureDir,
  readNativeMessage,
  writeNativeMessage,
  writePendingCapture
} from './host-core.mjs'

test('getPendingCaptureDir resolves a local app support pending folder', () => {
  const dir = getPendingCaptureDir({
    env: {},
    platform: 'darwin',
    homeDir: '/Users/kaan'
  })

  assert.equal(dir, '/Users/kaan/Library/Application Support/memry/capture-inbox/pending')
})

test('writePendingCapture durably writes the capture before Memry imports it', async () => {
  const captureDir = await mkdtemp(join(tmpdir(), 'memry-native-host-'))

  const result = await writePendingCapture(
    {
      schemaVersion: 1,
      capturedAt: '2026-05-13T10:00:00.000Z',
      source: 'chrome-extension',
      capture: {
        kind: 'link',
        url: 'https://example.com'
      }
    },
    { captureDir }
  )

  assert.equal(result.ok, true)
  assert.match(result.id, /^capture-/)

  const stored = JSON.parse(await readFile(result.path, 'utf8'))
  assert.equal(stored.capture.kind, 'link')
  assert.equal(stored.source, 'chrome-extension')
})

test('native messaging framing reads and writes one JSON message', async () => {
  const input = { ok: true, captureId: 'capture-1' }
  const frame = writeNativeMessage(input)
  const output = await readNativeMessage(frame)

  assert.deepEqual(output, input)
})
