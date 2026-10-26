// Captures an Electron 43.1.1 profile fixture for crates/memry-desktop (electron_import tests).
//
//   pnpm install            (repo root: the desktop app's own electron 43.1.1, y-leveldb and yjs)
//   node scripts/electron-fixtures/capture.mjs --out ../../crates/memry-desktop/tests/fixtures/electron/<macos|windows|linux>
//
// Writes <out>/<new|legacy>/ (a profile) and <out>/<new|legacy>.json (expected plaintexts, doc
// names and the throw-away key material the deterministic tests need). The app names are
// fixture-only: the real names `memrynote` and `@memry/desktop` would read or create the
// developer's real Safe Storage item, so they are refused.
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire as nodeRequire } from 'node:module'

// The capture runs against the root install: the exact electron, y-leveldb and yjs the shipped
// desktop app depends on, so no second Electron lockfile exists.
const require = nodeRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/package.json')
)
const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const out = path.resolve(arg('out', ''))
if (!arg('out')) throw new Error('--out <dir> is required')
const docCount = Number(arg('docs', '0'))

const RUNS = [
  { slug: 'new', appName: 'memry-fixture-new' },
  { slug: 'legacy', appName: 'memry-fixture-legacy' }
]
const FORBIDDEN = new Set(['memrynote', '@memry/desktop'])

const PLAINTEXTS = {
  'com.memry.sync': {
    'master-key': 'fixture-master-key-aGVsbG8=',
    'device-signing-key': 'fixture-device-signing-key-d29ybGQ=',
    'access-token': 'fixture.access.token',
    'refresh-token': 'fixture-refresh-token-0123456789abcdef',
    'setup-token': 'fixture-setup-token'
  },
  'com.memry.calendar.google': { refresh: 'fixture-google-refresh' },
  'com.memry.readwise': { token: 'fixture-readwise-token' }
}

const NOTE_ID = 'Note_Fixture-ID-01'
const JOURNAL_ID = 'j2026-08-13'
const FLUSHED_ID = 'flushed_doc'
const UNICODE_ID = 'not-ğüşiöç-日本語'
const VAULT_UUID = '0b6f6f08-3f0a-4d7d-9d0e-1d2c3b4a5f60'

async function writeYStore(dir, { docs }) {
  const Y = require('yjs')
  const { LeveldbPersistence } = require('y-leveldb')
  fs.mkdirSync(dir, { recursive: true })
  const persistence = new LeveldbPersistence(dir, {
    levelOptions: { cacheSize: 2 * 1024 * 1024, writeBufferSize: 1024 * 1024 }
  })
  const names = []
  const pending = []
  const store = (id) => (update) => pending.push(persistence.storeUpdate(id, update))
  // A note with more than 255 updates, so a clock needs more than one byte.
  const note = new Y.Doc()
  const text = note.getText('content')
  note.on('update', store(NOTE_ID))
  for (let i = 0; i < 300; i += 1) text.insert(text.length, `line ${i}\n`)
  await persistence.setMeta(NOTE_ID, 'memry.snapshotWatermark.v1', {
    appliedSequence: 42,
    snapshotRevision: 'rev-7'
  })
  await persistence.setMeta(NOTE_ID, 'adapter-snapshot-up-to-seq', 17)
  names.push(NOTE_ID)
  const journal = new Y.Doc()
  journal.on('update', store(JOURNAL_ID))
  journal.getText('content').insert(0, 'journal entry')
  await persistence.setMeta(JOURNAL_ID, 'memry.snapshotWatermark.v1', { appliedSequence: 'x' })
  names.push(JOURNAL_ID)
  const unicode = new Y.Doc()
  unicode.on('update', store(UNICODE_ID))
  unicode.getText('content').insert(0, 'unicode doc')
  names.push(UNICODE_ID)
  const flushed = new Y.Doc()
  flushed.on('update', store(FLUSHED_ID))
  flushed.getText('content').insert(0, 'flushed')
  names.push(FLUSHED_ID)
  await persistence.setMeta('__memry_crdt_store__', 'syncEpoch', 'epoch-fixture-1')
  names.push('__memry_crdt_store__')
  for (let i = 0; i < docs; i += 1) {
    const doc = new Y.Doc()
    const id = `bulk-${String(i).padStart(5, '0')}`
    doc.on('update', store(id))
    doc.getText('content').insert(0, `bulk ${i}`)
    names.push(id)
  }
  await Promise.all(pending)
  await persistence.flushDocument(FLUSHED_ID)
  await persistence.destroy()
  return names
}

// macOS: `--use-mock-keychain` (a Chromium switch) makes OSCrypt use its fixed mock Keychain
// password instead of the login keychain. The ciphertexts still come from Electron's own
// safeStorage, the capture never touches a real keychain item, and the key is known.
const MACOS_MOCK_PASSWORD = 'mock_password'

function recordKeyMaterial(appName, userData) {
  if (process.platform === 'darwin') return { macosPassword: MACOS_MOCK_PASSWORD }
  if (process.platform === 'win32') {
    const state = JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf-8'))
    const wrapped = state.os_crypt.encrypted_key
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${wrapped}'); $k=$b[5..($b.Length-1)]; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($k,$null,'CurrentUser'))`
    const key = execFileSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf-8'
    }).trim()
    return { windowsKeyBase64: key }
  }
  const password = execFileSync(
    'secret-tool',
    ['lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', appName],
    { encoding: 'utf-8' }
  ).trim()
  return { linuxPassword: password }
}

function copyProfile(userData, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of [
    'secure-secrets.json',
    'Local State',
    'Custom Dictionary.txt',
    'Custom Dictionary.txt.backup',
    'memry-config.json',
    'app-identity.json',
    'crdt-stores',
    'crdt-store',
    'Local Storage'
  ]) {
    const from = path.join(userData, entry)
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, entry), { recursive: true })
  }
  const stack = [dest]
  while (stack.length) {
    const dir = stack.pop()
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      // LOCK is process state; LOG records the host's temp path and nothing reads it.
      else if (['LOCK', 'LOG', 'LOG.old'].includes(e.name)) fs.rmSync(p)
    }
  }
}

const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform]
const electronBin = require('electron')

for (const { slug, appName } of RUNS) {
  console.log(`capturing ${slug}`)
  if (FORBIDDEN.has(appName)) throw new Error('refusing a real app name')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `memry-fixture-${slug}-`))
  const docNames = await writeYStore(path.join(userData, 'crdt-stores', VAULT_UUID), {
    docs: docCount
  })
  await writeYStore(path.join(userData, 'crdt-store'), { docs: 0 })
  fs.writeFileSync(
    path.join(userData, 'memry-config.json'),
    JSON.stringify(
      {
        currentVault: '/Users/fixture/vault',
        locale: 'tr',
        vaults: [
          {
            path: '/Users/fixture/vault',
            name: 'vault',
            noteCount: 3,
            taskCount: 1,
            lastOpened: '2026-08-13T10:00:00.000Z',
            isDefault: true,
            vaultUuid: VAULT_UUID
          }
        ],
        sync: {
          deviceId: 'device-fixture',
          email: 'fixture@example.com',
          recoveryPhraseConfirmed: true
        },
        futureSetting: { kept: true }
      },
      null,
      2
    )
  )
  const plaintextsPath = path.join(userData, '.plaintexts.json')
  fs.writeFileSync(plaintextsPath, JSON.stringify(PLAINTEXTS))
  const mockKeychain = process.platform === 'darwin' ? ['--use-mock-keychain'] : []
  const run = spawnSync(
    electronBin,
    [
      '--no-sandbox',
      ...mockKeychain,
      path.join(here, 'electron-main.cjs'),
      appName,
      userData,
      plaintextsPath,
      path.join(here, 'storage.html')
    ],
    { stdio: 'inherit', timeout: 120_000 }
  )
  if (run.status !== 0) throw new Error(`electron exited ${run.status}`)
  fs.rmSync(plaintextsPath)
  const keys = recordKeyMaterial(appName, userData)
  copyProfile(userData, path.join(out, slug))
  fs.writeFileSync(
    path.join(out, `${slug}.json`),
    JSON.stringify(
      {
        electron: '43.1.1',
        platform,
        appName,
        vaultUuid: VAULT_UUID,
        plaintexts: PLAINTEXTS,
        docs: docNames.filter((n) => !n.startsWith('bulk-')),
        noteId: NOTE_ID,
        journalId: JOURNAL_ID,
        unicodeId: UNICODE_ID,
        flushedId: FLUSHED_ID,
        ...keys
      },
      null,
      2
    ) + '\n'
  )
  fs.rmSync(userData, { recursive: true, force: true })
}
