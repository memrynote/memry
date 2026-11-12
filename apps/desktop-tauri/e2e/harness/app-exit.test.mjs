import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { crashEvidence, describeExit } from './app-exit.ts'

test('an app that died reads as its NTSTATUS, its code or its signal', () => {
  assert.equal(
    describeExit({ code: 0xc0000409, signal: null }),
    'code 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN (fail-fast))'
  )
  // A signed DWORD names the same status.
  assert.equal(
    describeExit({ code: 0xc0000005 | 0, signal: null }),
    'code 0xC0000005 (STATUS_ACCESS_VIOLATION)'
  )
  assert.equal(describeExit({ code: 0xc0001234, signal: null }), 'code 0xC0001234')
  assert.equal(describeExit({ code: 1, signal: null }), 'code 1')
  assert.equal(describeExit({ code: null, signal: 'SIGSEGV' }), 'signal SIGSEGV')
})

function dirs(t) {
  const root = mkdtempSync(join(tmpdir(), 'memry-app-exit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { appDataDir: join(root, 'data'), keepDir: join(root, 'kept'), root }
}

// The app's temp dirs are not uploaded, so the dump its monitor wrote must be copied out.
test("a dead app's minidump is copied where CI uploads it", async (t) => {
  const { appDataDir, keepDir } = dirs(t)
  mkdirSync(join(appDataDir, 'crash-dumps'), { recursive: true })
  writeFileSync(join(appDataDir, 'crash-dumps', 'a.dmp'), 'MDMP')
  const report = await crashEvidence(
    { appDataDir, pid: 4242, exit: { code: 0xc0000005, signal: null } },
    keepDir,
    'app-1-4242'
  )
  const kept = join(keepDir, 'app-1-4242-a.dmp')
  assert.match(report, new RegExp(`minidump ${kept.replace(/\\/g, '\\\\')} \\(4 bytes\\)`))
  assert.equal(readFileSync(kept, 'utf8'), 'MDMP')
})

// The monitor is another process and writes the dump after the app's exit is already seen.
test('a crash exit waits for the dump its monitor is still writing', async (t) => {
  const { appDataDir, keepDir } = dirs(t)
  const dumps = join(appDataDir, 'crash-dumps')
  mkdirSync(dumps, { recursive: true })
  setTimeout(() => writeFileSync(join(dumps, 'late.dmp'), 'MDMP'), 500)
  const report = await crashEvidence(
    { appDataDir, pid: 4242, exit: { code: 0xc0000409, signal: null } },
    keepDir,
    't'
  )
  assert.match(report, /minidump .*t-late\.dmp/)
})

test('the WER dump of the dead pid is kept, not the dumps of other pids', async (t) => {
  const { appDataDir, keepDir, root } = dirs(t)
  const wer = join(root, 'wer')
  mkdirSync(wer)
  writeFileSync(join(wer, 'Memrynote.exe.4242.dmp'), 'MDMP')
  writeFileSync(join(wer, 'Memrynote.exe.4243.dmp'), 'MDMP')
  const saved = process.env.MEMRY_E2E_WER_DUMPS
  process.env.MEMRY_E2E_WER_DUMPS = wer
  t.after(() => {
    if (saved === undefined) delete process.env.MEMRY_E2E_WER_DUMPS
    else process.env.MEMRY_E2E_WER_DUMPS = saved
  })
  const report = await crashEvidence(
    { appDataDir, pid: 4242, exit: { code: 0xc0000409, signal: null } },
    keepDir,
    't'
  )
  assert.match(report, /t-Memrynote\.exe\.4242\.dmp/)
  assert.doesNotMatch(report, /4243/)
})

test('an app that left no dump says so', async (t) => {
  const { appDataDir, keepDir } = dirs(t)
  const report = await crashEvidence(
    { appDataDir, pid: 4242, exit: { code: 1, signal: null } },
    keepDir,
    't'
  )
  assert.match(report, /no minidump in crash-dumps or WER/)
})
