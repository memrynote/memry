// Captures the Electron profile fixture of the first-launch migration tests (Step 37, #3554):
// crates/memry-desktop/tests/fixtures/electron-profile/{profile,vault,expected.json}.
//
//   pnpm install                           (repo root)
//   pnpm --filter @memry/desktop rebuild:node
//   node scripts/electron-fixtures/capture-profile.mjs      (macOS only)
//
// Each part comes from the Electron code that writes it in production, with synthetic data only:
// - vault: the desktop app's own `createNote`, indexer, migrations and `bindLocalVaultToMasterKey`
//   under its vitest config (as capture-vault.mjs does), its `data.db` and `index.db` gzipped;
// - `crdt-stores/<vault uuid>` and the legacy `crdt-store/`: y-leveldb with bodies seeded by the
//   app's own `markdownToYFragment`, one note edited after its snapshot watermark (never pushed);
// - `secure-secrets.json`, `Local State`, `Local Storage/` and `Custom Dictionary.txt`: Electron
//   43.1.1 itself (electron-main.cjs), under `--use-mock-keychain`, so no keychain item is read
//   or written and the decryption password is Chromium's fixed mock password;
// - `memry-config.json`, `telemetry.json`, `app-identity.json`, models, OCR languages, the
//   Sandbox vault, updater markers and the bulk-apply journal in the shapes their writers use.
//
// A real profile holds absolute paths (`vaults[].path`, journal entries). The fixture writes
// `PROFILE_PLACEHOLDER` and `VAULT_PLACEHOLDER` there; the Rust helper replaces them with the
// test's copy. The ids are random, so a capture replaces the whole fixture.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '../..')
const desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const testFile = path.join(desktop, 'src/main/vault/electron-profile-fixture.capture.test.ts')
const out = path.join(root, 'crates/memry-desktop/tests/fixtures/electron-profile')

const PROFILE_PLACEHOLDER = '/memry-fixture/profile'
const VAULT_PLACEHOLDER = '/memry-fixture/vault'
const MACOS_MOCK_PASSWORD = 'mock_password'
const FIXTURE_APP_NAME = 'memry-fixture-profile'

if (process.platform !== 'darwin') {
  // Windows (DPAPI) and Linux (libsecret) ciphertexts are bound to the capturing user; Step 06's
  // per-OS fixtures (capture.mjs) cover those decryptors.
  throw new Error('capture-profile.mjs runs on macOS (mock keychain) only')
}

const TEST = `/**
 * Writes the vault and CRDT stores of the Electron profile fixture
 * (\`crates/memry-desktop/tests/fixtures/electron-profile\`, Step 37 #3554). Driven by
 * scripts/electron-fixtures/capture-profile.mjs; runs only with \`MEMRY_ELECTRON_PROFILE_OUT=<dir>\`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { gzipSync } from 'zlib'
import * as Y from 'yjs'
import { LeveldbPersistence } from 'y-leveldb'
import sodium from 'libsodium-wrappers-sumo'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { createNoteDerivedStateProjector } from '../projections/projectors/note-derived-state-projector'
import { startProjectionRuntime, stopProjectionRuntime } from '../projections'
import type * as DatabaseModule from '../database'

const OUT = process.env.MEMRY_ELECTRON_PROFILE_OUT
const state = vi.hoisted(() => ({ vault: '' }))

vi.mock('electron', () => {
  const mockWindow = { isDestroyed: () => false, webContents: { send: () => undefined } }
  return {
    BrowserWindow: { getAllWindows: () => [mockWindow] },
    shell: { openPath: () => Promise.resolve(''), showItemInFolder: () => undefined }
  }
})
// The capture never reaches an OS keychain: the keys are synthetic and handed over in capture.json.
vi.mock('../crypto/keychain', () => ({
  retrieveKey: async () => null,
  storeKey: async () => {
    throw new Error('the profile capture never writes a keychain')
  },
  confirmMasterKeyMigrated: async () => undefined
}))
vi.mock('./status', async () => await import('./index'))
vi.mock('./index', () => ({
  getConfig: (): VaultConfig => ({
    excludePatterns: ['.git', 'node_modules', '.trash'],
    defaultNoteFolder: 'notes',
    journalFolder: 'journal',
    journalDateFormat: 'YYYY-MM-DD',
    attachmentsFolder: 'attachments'
  }),
  getStatus: () => ({
    isOpen: true,
    path: state.vault,
    isIndexing: false,
    indexProgress: 100,
    error: null
  }),
  getVaultPath: () => state.vault,
  emitIndexProgress: () => undefined
}))
vi.mock('../inbox/suggestions', () => ({ updateNoteEmbedding: () => Promise.resolve() }))
vi.mock('../tasks/reconcile-markdown-tasks', () => ({
  reconcileTaskCheckboxesFromMarkdown: async () => 0
}))
vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: async () => false }))

const DEVICE_ID = '7c1e0c55-6f2b-4a8e-9d0b-2f1a3c4d5e6f'
const DELETED_NOTE_ID = 'k3v9deletedx'
const WATERMARK = { appliedSequence: 7, snapshotRevision: 'rev-fixture-7' }

function body(file: string): string {
  return fs.readFileSync(file, 'utf-8').replace(/^---\\n[\\s\\S]*?\\n---\\n/, '')
}

describe.skipIf(!OUT)('electron profile fixture', () => {
  let vault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeAll(async () => {
    vault = createTestVault('electron-profile-fixture')
    state.vault = vault.path
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    const database: typeof DatabaseModule = await import('../database')
    vi.spyOn(database, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => undefined)
    const client = await import('../database/client')
    vi.spyOn(client, 'getDatabase').mockReturnValue(asClientDb(dataDb.db))
    vi.spyOn(client, 'getIndexDatabase').mockReturnValue(indexDb.db)
    startProjectionRuntime([createNoteDerivedStateProjector(() => vault.path)])
  })

  afterAll(async () => {
    await stopProjectionRuntime({ drain: true })
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    vault.cleanup()
  })

  it('writes the vault and the CRDT stores', async () => {
    await sodium.ready
    const { createNote } = await import('./notes')
    const { indexVault } = await import('./indexer')
    const { getOrCreateVaultUuid } = await import('../agent/storage/vault-id')
    const { bindLocalVaultToMasterKey } = await import('../crypto/vault-key-state')
    const { generateKeyVerifier } = await import('../crypto/keys')
    const { markdownToYFragment } = await import('../sync/blocknote-converter')
    const at = (day: number): string => '2025-01-0' + day + 'T10:00:00.000Z'

    await createNote({ title: 'Getting Started', content: 'Welcome to the fixture vault.\\n', created: at(1), modified: at(1) })
    await createNote({ title: 'Offline edits', content: 'This paragraph was synced.\\n', created: at(2), modified: at(2) })
    await createNote({ title: 'Plan', folder: 'projects/2025', content: 'First step.\\n', created: at(3), modified: at(3) })
    await createNote({
      title: 'Tagged',
      content: 'With frontmatter.\\n',
      tags: ['work'],
      properties: { status: 'draft' },
      created: at(4),
      modified: at(4)
    })
    fs.writeFileSync(path.join(vault.notesDir, 'outside.md'), 'Written by another program.\\n')
    fs.writeFileSync(path.join(vault.journalDir, '2025-01-01.md'), 'A journal day.\\n')
    await indexVault(vault.path)
    await stopProjectionRuntime({ drain: true })

    const notes = dataDb.sqlite
      .prepare('SELECT id, path, title FROM note_metadata ORDER BY path')
      .all() as Array<{ id: string; path: string; title: string }>
    const byPath = (p: string): string => notes.find((n) => n.path === p)!.id
    const offlineId = byPath('notes/Offline edits.md')
    const legacyId = byPath('notes/outside.md')
    const journalId = byPath('journal/2025-01-01.md')
    const unattributableSource = byPath('notes/Getting Started.md')

    const db = asClientDb(dataDb.db)
    const vaultUuid = getOrCreateVaultUuid(dataDb.db)
    const masterKey = sodium.crypto_generichash(32, 'memry-fixture-master-key')
    await bindLocalVaultToMasterKey(db, vaultUuid, masterKey)
    const accountKeyVerifier = await generateKeyVerifier(masterKey)
    const signing = sodium.crypto_sign_seed_keypair(
      sodium.crypto_generichash(32, 'memry-fixture-device-seed')
    )
    const b64 = (bytes: Uint8Array): string =>
      sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

    const now = Date.parse('2025-01-05T10:00:00.000Z') / 1000
    const clock = JSON.stringify({ [DEVICE_ID]: 1 })
    const run = (sql: string, ...params: unknown[]): void => {
      dataDb.sqlite.prepare(sql).run(...params)
    }
    run(
      'INSERT INTO sync_devices (id, name, platform, os_version, app_version, linked_at, last_sync_at, is_current_device, signing_public_key) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      DEVICE_ID, 'Fixture Mac', 'macos', '15.1', '2026.1101.1', now, now, b64(signing.publicKey)
    )
    run("INSERT INTO projects (id, name, is_inbox, position) VALUES ('inbox-project', 'Inbox', 1, 0)")
    run(
      "INSERT INTO projects (id, name, color, position, clock) VALUES ('project-fixture', 'Fixture project', '#6366f1', 1, ?)",
      clock
    )
    const repeat = {
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [1],
      endType: 'never',
      completedCount: 0,
      createdAt: at(1)
    }
    run(
      "INSERT INTO tasks (id, project_id, title, priority, position, due_date, repeat_config, repeat_from, clock) VALUES ('task-fixture-weekly', 'project-fixture', 'Weekly review', 2, 0, '2025-01-06', ?, 'due', ?)",
      JSON.stringify(repeat), clock
    )
    run(
      "INSERT INTO inbox_items (id, type, title, content, created_at, modified_at) VALUES ('inbox-fixture-1', 'note', 'Captured thought', 'Remember the fixture.', ?, ?)",
      at(5), at(5)
    )
    run(
      "INSERT INTO sync_queue (id, type, item_id, operation, payload, priority, attempts, created_at) VALUES ('queue-fixture-1', 'task', 'task-fixture-weekly', 'create', ?, 0, 0, ?)",
      JSON.stringify({ id: 'task-fixture-weekly', title: 'Weekly review' }), now
    )
    run(
      "INSERT INTO sync_pending_deletes (type, item_id, payload, created_at) VALUES ('note', ?, ?, ?)",
      DELETED_NOTE_ID, JSON.stringify({ id: DELETED_NOTE_ID, clock: { [DEVICE_ID]: 3 } }), now
    )
    run("INSERT INTO sync_state (key, value, updated_at) VALUES ('lastCursor', '41', ?)", now)

    const out = OUT as string
    const profile = path.join(out, 'profile')
    const seed = async (markdown: string): Promise<Y.Doc> => {
      const doc = new Y.Doc()
      expect(await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))).toBe(true)
      return doc
    }

    const store = new LeveldbPersistence(path.join(profile, 'crdt-stores', vaultUuid))
    for (const note of notes) {
      if (note.id === legacyId) continue
      const doc = await seed(body(path.join(vault.path, note.path)))
      await store.storeUpdate(note.id, Y.encodeStateAsUpdate(doc))
      if (note.id !== offlineId) continue
      // Synced up to the watermark, then edited offline: the second update was never pushed.
      await store.setMeta(note.id, 'memry.snapshotWatermark.v1', WATERMARK)
      const before = Y.encodeStateVector(doc)
      const group = doc.getXmlFragment(CRDT_FRAGMENT_NAME).get(0) as Y.XmlElement
      const last = group.get(group.length - 1) as Y.XmlElement
      const sibling = last.get(0) as Y.XmlElement
      const container = new Y.XmlElement('blockContainer')
      container.setAttribute('id', 'fixture-offline-block')
      const paragraph = new Y.XmlElement(sibling.nodeName)
      for (const [key, value] of Object.entries(sibling.getAttributes())) {
        paragraph.setAttribute(key, value as string)
      }
      paragraph.insert(0, [new Y.XmlText('Edited offline, never pushed.')])
      container.insert(0, [paragraph])
      group.insert(group.length, [container])
      expect(doc.getXmlFragment(CRDT_FRAGMENT_NAME).toString()).toContain('Edited offline')
      await store.storeUpdate(note.id, Y.encodeStateAsUpdate(doc, before))
    }
    // Deleted notes keep their document; the legacy partition's set-aside copies are skipped.
    const deleted = await seed('Deleted before quitting.\\n')
    await store.storeUpdate(DELETED_NOTE_ID, Y.encodeStateAsUpdate(deleted))
    const setAside = await seed('Set aside by the legacy partition.\\n')
    const unattributableId = '__memry_unattributable__/' + unattributableSource
    await store.storeUpdate(unattributableId, Y.encodeStateAsUpdate(setAside))
    await store.setMeta('__memry_crdt_store__', 'syncEpoch', 'epoch-fixture-1')
    await store.setMeta('__memry_owed_compactions__', 'owedCompactions', [])
    await store.destroy()

    // The pre-per-vault global store, claimed by this vault, holds the one document the
    // per-vault store lacks.
    const legacy = new LeveldbPersistence(path.join(profile, 'crdt-store'))
    const legacyDoc = await seed(body(path.join(vault.path, 'notes/outside.md')))
    await legacy.storeUpdate(legacyId, Y.encodeStateAsUpdate(legacyDoc))
    await legacy.destroy()

    const vaultOut = path.join(out, 'vault')
    fs.cpSync(vault.path, vaultOut, { recursive: true })
    fs.writeFileSync(path.join(vaultOut, '.memry', 'data.db.gz'), gzipSync(dataDb.sqlite.serialize()))
    fs.writeFileSync(path.join(vaultOut, '.memry', 'index.db.gz'), gzipSync(indexDb.sqlite.serialize()))
    fs.writeFileSync(
      path.join(out, 'capture.json'),
      JSON.stringify({
        vaultUuid,
        deviceId: DEVICE_ID,
        masterKey: b64(masterKey),
        deviceSigningKey: b64(signing.privateKey),
        accountKeyVerifier,
        notes,
        offlineDocId: offlineId,
        watermark: WATERMARK,
        deletedDocId: DELETED_NOTE_ID,
        legacyDocId: legacyId,
        journalDocId: journalId,
        unattributableDocId: unattributableId
      })
    )
  })
})
`

/** Runs the vitest half; returns its `capture.json`. */
function captureVault(stage) {
  fs.writeFileSync(testFile, TEST)
  try {
    const run = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--config',
        'config/vitest.config.ts',
        '--project',
        'main',
        testFile
      ],
      { cwd: desktop, stdio: 'inherit', env: { ...process.env, MEMRY_ELECTRON_PROFILE_OUT: stage } }
    )
    if (run.status !== 0) throw new Error(`vitest exited ${run.status}`)
  } finally {
    fs.rmSync(testFile, { force: true })
  }
  return JSON.parse(fs.readFileSync(path.join(stage, 'capture.json'), 'utf-8'))
}

/** Electron 43.1.1 writes its own formats into a scratch userData; the profile takes them. */
function captureElectronFormats(profile, plaintexts) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-profile-electron-'))
  try {
    const plaintextsPath = path.join(userData, '.plaintexts.json')
    fs.writeFileSync(plaintextsPath, JSON.stringify(plaintexts))
    const run = spawnSync(
      require('electron'),
      [
        '--no-sandbox',
        '--use-mock-keychain',
        path.join(here, 'electron-main.cjs'),
        FIXTURE_APP_NAME,
        userData,
        plaintextsPath,
        path.join(here, 'storage.html')
      ],
      { stdio: 'inherit', timeout: 120_000 }
    )
    fs.rmSync(plaintextsPath)
    if (run.status !== 0) throw new Error(`electron exited ${run.status}`)
    for (const entry of [
      'secure-secrets.json',
      'Local State',
      'Local Storage',
      'Custom Dictionary.txt',
      'Custom Dictionary.txt.backup'
    ]) {
      const from = path.join(userData, entry)
      if (fs.existsSync(from)) fs.cpSync(from, path.join(profile, entry), { recursive: true })
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
}

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')

/** The userData files Electron writes outside LevelDB and safeStorage. */
function writeProfileFiles(profile, cap) {
  const lastOpened = '2025-01-05T10:00:00.000Z'
  // store.ts StoreSchema, plus a key this reader does not know (unknown keys are kept).
  writeJson(path.join(profile, 'memry-config.json'), {
    locale: 'tr',
    currentVault: VAULT_PLACEHOLDER,
    vaults: [
      {
        path: VAULT_PLACEHOLDER,
        name: 'Fixture Vault',
        noteCount: cap.notes.length,
        taskCount: 1,
        lastOpened,
        isDefault: true,
        vaultUuid: cap.vaultUuid,
        accountBinding: { userId: 'user-fixture-0001', mode: 'sync' }
      }
    ],
    sync: {
      recoveryPhraseConfirmed: true,
      email: 'fixture@example.com',
      deviceId: cap.deviceId,
      accountVaultsCache: {
        fetchedAt: 1736071200000,
        vaults: [
          {
            vaultUuid: cap.vaultUuid,
            name: 'Fixture Vault',
            itemCount: 9,
            createdAt: 1735725600000
          }
        ]
      },
      entitlement: { isPaid: false, plan: 'free', status: 'active' },
      accountKeyVerifier: cap.accountKeyVerifier
    },
    agent: { disclosureAccepted: true, accessMode: 'vault_only' },
    captureAllowedOrigins: ['chrome-extension://fixtureextensionid'],
    updater: { autoDownload: true, autoCheck: true },
    windowBounds: { width: 1280, height: 820, x: 80, y: 60, isMaximized: false },
    crdtStore: { legacyStoreClaimedBy: cap.vaultUuid, legacyStoreClaimedAt: 1735725600000 },
    ocrLanguages: ['deu'],
    futureSetting: { kept: true }
  })
  writeJson(path.join(profile, 'app-identity.json'), {
    version: 1,
    appName: 'memrynote',
    flipped: true
  })
  writeJson(path.join(profile, 'telemetry.json'), {
    installId: '3f6c2a8e-1b4d-4e7a-9c5f-0d2e8b7a6c41',
    enabled: false,
    autoSendDiagnostics: false,
    lastRunVersion: '2026.1101.1',
    diagnosticsSalt: 'fixture-salt'
  })
  const write = (rel, content) => {
    const file = path.join(profile, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  write(
    'models/transformers/onnx-community/fixture-model/config.json',
    '{"model_type":"fixture"}\n'
  )
  write('models/transformers/onnx-community/fixture-model/onnx/model.onnx', Buffer.alloc(4096, 7))
  writeJson(path.join(profile, 'models/voice-transcription/whisper-small.json'), {
    downloaded: true
  })
  write('ocr-languages/deu.traineddata', Buffer.alloc(2048, 3))
  write('sync-packs/pack-fixture.bin', Buffer.alloc(512, 1))
  write('logs/main.log', '[2025-01-05 10:00:00.000] [info] fixture log line\n')
  write('Sandbox/Welcome.md', '# Welcome\n\nGenerated sandbox content.\n')
  writeJson(path.join(profile, 'sandbox-vault.json'), { generatorVersion: 1 })
  writeJson(path.join(profile, 'update-install-attempt.json'), {
    fromVersion: '2026.1015.1',
    toVersion: 'v2026-11-01',
    startedAt: '2026-11-01T09:30:15.123Z',
    installer: 'velopack'
  })
  writeJson(path.join(profile, 'update-install-health.json'), {
    fromVersion: 'v2026-10-15',
    targetVersion: 'v2026-11-01',
    consecutiveFailures: 1,
    escalated: false
  })
  writeJson(path.join(profile, 'pending-update-install.json'), {
    fromVersion: '2026.1015.1',
    createdAt: 1761989415123
  })
  writeJson(path.join(profile, 'crdt-pending-notes.json'), [cap.offlineDocId])
  // bulk-apply.ts JournalFile: two writes, a third whose sha256 does not match its content.
  const entry = (rel, content, sha) => ({
    absolutePath: `${VAULT_PLACEHOLDER}/${rel}`,
    content,
    sha256: sha ?? sha256(content)
  })
  writeJson(path.join(profile, 'sync-bulk-apply-journal.json'), {
    writtenAt: 1736071200000,
    entries: [
      entry('notes/Replayed one.md', '# Replayed one\n\nArrived by sync.\n'),
      entry('notes/Replayed two.md', '# Replayed two\n\nAlso arrived.\n'),
      entry('notes/Torn.md', '# Torn\n\nContent.\n', sha256('other content'))
    ]
  })
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-profile-capture-'))
try {
  const cap = captureVault(stage)
  const profile = path.join(stage, 'profile')
  const plaintexts = {
    'com.memry.sync': {
      'master-key': cap.masterKey,
      'device-signing-key': cap.deviceSigningKey,
      'access-token': 'fixture.access.token',
      'refresh-token': 'fixture-refresh-token-0123456789abcdef',
      'setup-token': 'fixture-setup-token'
    },
    'com.memry.calendar.google': { refresh: 'fixture-google-refresh' },
    'com.memry.readwise': { token: 'fixture-readwise-token' }
  }
  captureElectronFormats(profile, plaintexts)
  writeProfileFiles(profile, cap)
  for (const dir of [
    path.join(profile, 'crdt-stores'),
    path.join(profile, 'crdt-store'),
    profile
  ]) {
    const stack = [dir]
    while (stack.length) {
      const d = stack.pop()
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) stack.push(p)
        // LOCK is process state; LOG records the host's temp path and nothing reads it.
        else if (['LOCK', 'LOG', 'LOG.old'].includes(e.name)) fs.rmSync(p)
      }
    }
  }

  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  fs.cpSync(profile, path.join(out, 'profile'), { recursive: true })
  fs.cpSync(path.join(stage, 'vault'), path.join(out, 'vault'), { recursive: true })
  fs.writeFileSync(path.join(out, '.gitattributes'), '* -text -whitespace\n')
  writeJson(path.join(out, 'expected.json'), {
    electron: '43.1.1',
    platform: 'macos',
    macosPassword: MACOS_MOCK_PASSWORD,
    profilePlaceholder: PROFILE_PLACEHOLDER,
    vaultPlaceholder: VAULT_PLACEHOLDER,
    plaintexts,
    ...cap
  })
  fs.appendFileSync(path.join(out, 'expected.json'), '\n')
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
