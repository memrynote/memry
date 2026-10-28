import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { findSyncHostRequests } from './check-renderer-no-sync-host.mjs'

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-renderer-no-sync-host.mjs')

test('check-renderer-no-sync-host', async (t) => {
  await t.test('flags every way the renderer could request a memry host', () => {
    for (const source of [
      "await fetch('https://sync.memrynote.com/sync/status')",
      'await fetch(`https://${region}.memrynote.com/x`, { method: "POST" })',
      "const SYNC = 'https://sync-staging.memrynote.com'\nawait fetch(SYNC + '/sync/pull')",
      "const ws = new WebSocket('wss://sync.memrynote.com/sync/ws')",
      'const source = new EventSource(syncServerUrl + "/events")',
      'navigator.sendBeacon(import.meta.env.VITE_SYNC_SERVER_URL, body)',
      "const xhr = new XMLHttpRequest()\nxhr.open('POST', 'https://sync.memrynote.com/telemetry/batch')",
      "await fetch(\n  'https://sync.memrynote.com/a',\n  { method: 'GET' }\n)"
    ]) {
      assert.equal(findSyncHostRequests(source).length, 1, source)
    }
  })

  await t.test('leaves links, comments and other hosts alone', () => {
    for (const source of [
      "window.open('https://docs.memrynote.com', '_blank')",
      "const DOWNLOAD_URL = 'https://memrynote.com/download/desktop'\n<a href={DOWNLOAD_URL} />",
      "// await fetch('https://sync.memrynote.com')",
      "/* new WebSocket('wss://sync.memrynote.com') */",
      'await fetch(audioUrl)',
      "await fetch('https://cdn.syndication.twimg.com/tweet-result?id=1')",
      "dialog.open('https://memrynote.com/pricing')"
    ]) {
      assert.deepEqual(findSyncHostRequests(source), [], source)
    }
  })

  await t.test('a comment marker inside a string does not hide the code after it', () => {
    for (const source of [
      "const accept = 'image/*'\nawait fetch('https://sync.memrynote.com/x')\nconst done = '*/'",
      'const glob = "a/*"\nawait fetch(`https://sync.memrynote.com/x`)',
      "const url = `https://example.com//path`\nawait fetch('https://sync.memrynote.com/x')"
    ]) {
      assert.equal(findSyncHostRequests(source).length, 1, source)
    }
  })

  await t.test('names the line of the offending call', () => {
    const [found] = findSyncHostRequests(
      "const a = 1\n\nawait fetch('https://sync.memrynote.com/x')"
    )
    assert.equal(found.line, 3)
  })

  await t.test('passes on the renderer today and says how many files it read', () => {
    const output = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    const match = output.match(/passed \((\d+) files\)/)
    assert.ok(match, output)
    assert.ok(Number(match[1]) > 100, 'a pass over almost nothing is not a pass')
  })
})
