import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  getPendingCaptureDir,
  launchMemry,
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

test('getPendingCaptureDir uses MEMRY_CAPTURE_DIR as the final pending folder', () => {
  const dir = getPendingCaptureDir({
    env: {
      MEMRY_CAPTURE_DIR: '/Users/kaan/Library/Application Support/memry-dev/capture-inbox/pending'
    },
    platform: 'darwin',
    homeDir: '/Users/kaan'
  })

  assert.equal(dir, '/Users/kaan/Library/Application Support/memry-dev/capture-inbox/pending')
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

test('readNativeMessage resolves after one framed message without waiting for stdin EOF', async () => {
  const input = { ok: true, captureId: 'capture-1' }
  const frame = writeNativeMessage(input)
  const stream = new PassThrough()
  stream.write(frame)

  try {
    const output = await Promise.race([
      readNativeMessage(stream),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 50))
    ])

    assert.deepEqual(output, input)
  } finally {
    stream.destroy()
  }
})

test('launchMemry ignores shell launch environment overrides', () => {
  const calls = []

  launchMemry({
    env: {
      MEMRY_CAPTURE_OPEN_COMMAND: 'touch /tmp/memry-capture-owned',
      SHELL: '/tmp/untrusted-shell'
    },
    platform: 'darwin',
    spawnImpl: (command, args) => {
      calls.push({ command, args })
      return { unref() {} }
    }
  })

  assert.deepEqual(calls, [{ command: 'open', args: ['-a', 'Memry'] }])
})

test('launchMemry accepts only absolute macOS app bundle paths from the environment', () => {
  const calls = []
  const spawnImpl = (command, args) => {
    calls.push({ command, args })
    return { unref() {} }
  }

  launchMemry({
    env: { MEMRY_APP_PATH: '/Applications/Memry.app' },
    platform: 'darwin',
    spawnImpl
  })
  launchMemry({
    env: { MEMRY_APP_PATH: 'Memry.app' },
    platform: 'darwin',
    spawnImpl
  })

  assert.deepEqual(calls, [
    { command: 'open', args: ['/Applications/Memry.app'] },
    { command: 'open', args: ['-a', 'Memry'] }
  ])
})
