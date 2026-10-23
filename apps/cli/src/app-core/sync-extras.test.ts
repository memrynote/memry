import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { crdtOwedFileBodies, syncDevices, syncQueue, settings } from '@memry/db-schema/data-schema'
import { noteBodySync } from '@memry/db-schema/schema/note-body-sync'

import {
  classifyNoteSyncSize as desktopClassify,
  NOTE_SYNC_MAX_BYTES as DESKTOP_MAX
} from '../../../../packages/sync-client/src/note-size.ts'
import { runCli } from '../run.ts'
import { openDatabases } from './database.ts'
import { classifyNoteSyncSize, NOTE_SYNC_MAX_BYTES, NOTE_SYNC_WARN_BYTES } from './sync-extras.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-sync-extras')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

async function run(vaultPath: string, args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

async function runOk<T>(vaultPath: string, args: string[]): Promise<T> {
  const result = await run(vaultPath, args)
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout) as T
}

function withDatabases<T>(
  vaultPath: string,
  callback: (databases: ReturnType<typeof openDatabases>) => T
): T {
  const databases = openDatabases(vaultPath)
  try {
    return callback(databases)
  } finally {
    databases.close()
  }
}

function linkDevice(vaultPath: string): void {
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .insert(syncDevices)
      .values({
        id: 'device_1',
        name: 'Laptop',
        platform: 'macos',
        appVersion: '1.0.0',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'key'
      })
      .run()
  })
}

function queueBody(vaultPath: string, noteId: string, type = 'note_body'): void {
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .insert(syncQueue)
      .values({
        id: `queue_${randomUUID()}`,
        type,
        itemId: noteId,
        operation: 'update',
        payload: '{}',
        createdAt: new Date(1_700_000_000_000)
      })
      .run()
  })
}

test('the size ceiling matches @memry/sync-client', () => {
  assert.equal(NOTE_SYNC_MAX_BYTES, DESKTOP_MAX)
  for (const bytes of [
    0,
    NOTE_SYNC_WARN_BYTES - 1,
    NOTE_SYNC_WARN_BYTES,
    NOTE_SYNC_MAX_BYTES,
    NOTE_SYNC_MAX_BYTES + 1
  ]) {
    assert.equal(classifyNoteSyncSize(bytes), desktopClassify(bytes), `${bytes} bytes`)
  }
})

test('sync note-state follows the note from unsynced to pending to sent to confirmed', async () => {
  const vault = await makeVault()
  const note = await runOk<{ id: string; path: string }>(vault, ['notes', 'create', 'Draft'])

  assert.equal(
    (await runOk<{ state: string }>(vault, ['sync', 'note-state', note.id])).state,
    'not_syncing'
  )

  linkDevice(vault)
  assert.equal(
    (await runOk<{ state: string }>(vault, ['sync', 'note-state', note.id])).state,
    'not_recorded'
  )

  queueBody(vault, note.id)
  const pending = await runOk<{ state: string; waitingSince: number }>(vault, [
    'sync',
    'note-state',
    note.path
  ])
  assert.equal(pending.state, 'pending')
  assert.equal(pending.waitingSince, 1_700_000_000_000)

  withDatabases(vault, ({ dataDb }) => {
    dataDb
      .insert(noteBodySync)
      .values({ noteId: note.id, lastSentAt: 2_000, updatedAt: 2_000 })
      .run()
  })
  assert.equal(
    (await runOk<{ state: string }>(vault, ['sync', 'note-state', note.id])).state,
    'sent'
  )

  withDatabases(vault, ({ dataDb }) => {
    dataDb.delete(syncQueue).run()
    dataDb.update(noteBodySync).set({ lastConfirmedAt: 3_000 }).run()
  })
  const confirmed = await runOk<{ state: string; bodyConfirmedAt: number }>(vault, [
    'sync',
    'note-state',
    note.id
  ])
  assert.equal(confirmed.state, 'confirmed')
  assert.equal(confirmed.bodyConfirmedAt, 3_000)

  await runOk(vault, ['notes', 'set-local-only', note.id, 'true'])
  assert.equal(
    (await runOk<{ state: string }>(vault, ['sync', 'note-state', note.id])).state,
    'local_only'
  )

  const missing = await run(vault, ['sync', 'note-state', 'note_missing'])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /Note not found/)
})

test('sync unsent-notes lists queued, owed and rejected notes, rejected first, and skips local-only', async () => {
  const vault = await makeVault()
  linkDevice(vault)
  const queued = await runOk<{ id: string }>(vault, ['notes', 'create', 'Queued'])
  const owed = await runOk<{ id: string }>(vault, ['notes', 'create', 'Owed'])
  const rejected = await runOk<{ id: string }>(vault, ['notes', 'create', 'Rejected'])
  const localOnly = await runOk<{ id: string }>(vault, ['notes', 'create', 'Private'])
  const clean = await runOk<{ id: string }>(vault, ['notes', 'create', 'Clean'])
  await runOk(vault, ['notes', 'set-local-only', localOnly.id, 'true'])

  queueBody(vault, queued.id)
  queueBody(vault, queued.id, 'note')
  queueBody(vault, localOnly.id)
  withDatabases(vault, ({ dataDb }) => {
    dataDb
      .insert(crdtOwedFileBodies)
      .values({ noteId: owed.id, createdAt: 1_600_000_000_000 })
      .run()
    dataDb
      .insert(noteBodySync)
      .values({ noteId: rejected.id, lastSentAt: 1, lastRejectedAt: 5, updatedAt: 5 })
      .run()
    dataDb
      .insert(noteBodySync)
      .values({ noteId: clean.id, lastSentAt: 1, lastConfirmedAt: 2, updatedAt: 2 })
      .run()
  })

  const result = await runOk<{
    total: number
    notes: Array<{ id: string; reasons: string[]; state: string }>
  }>(vault, ['sync', 'unsent-notes'])
  assert.equal(result.total, 3)
  assert.deepEqual(
    result.notes.map((note) => note.id),
    [rejected.id, owed.id, queued.id]
  )
  assert.deepEqual(result.notes[0]?.reasons, ['rejected'])
  assert.deepEqual(result.notes[1]?.reasons, ['file_not_taken'])
  assert.deepEqual(result.notes[2]?.reasons, ['body', 'record'])
})

test('sync large-notes reports notes near or over the sync ceiling', async () => {
  const vault = await makeVault()
  await runOk(vault, ['notes', 'create', 'Small', '--content', 'tiny'])
  const big = await runOk<{ id: string }>(vault, [
    'notes',
    'create',
    'Huge',
    '--content',
    'x'.repeat(NOTE_SYNC_MAX_BYTES + 10)
  ])
  const near = await runOk<{ id: string }>(vault, [
    'notes',
    'create',
    'Near',
    '--content',
    'y'.repeat(NOTE_SYNC_WARN_BYTES + 10)
  ])

  const result = await runOk<{
    maxBytes: number
    notes: Array<{ id: string; status: string; sizeBytes: number }>
  }>(vault, ['sync', 'large-notes'])
  assert.equal(result.maxBytes, NOTE_SYNC_MAX_BYTES)
  assert.deepEqual(
    result.notes.map((note) => [note.id, note.status]),
    [
      [big.id, 'over'],
      [near.id, 'approaching']
    ]
  )
  assert.ok(result.notes[0]!.sizeBytes > result.notes[1]!.sizeBytes)
})

test('sync binding reads the vault account choice', async () => {
  const vault = await makeVault()
  assert.deepEqual(await runOk(vault, ['sync', 'binding']), { status: 'unbound', mode: null })
  const bind = (value: string) =>
    withDatabases(vault, ({ dataDb }) => {
      dataDb
        .insert(settings)
        .values({ key: 'sync.account-binding.v1', value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run()
    })
  bind(JSON.stringify({ userId: 'user_1', mode: 'sync' }))
  assert.deepEqual(await runOk(vault, ['sync', 'binding']), { status: 'sync', mode: 'sync' })
  bind(JSON.stringify({ userId: 'user_1', mode: 'local' }))
  assert.deepEqual(await runOk(vault, ['sync', 'binding']), { status: 'local-only', mode: 'local' })
  bind('not json')
  assert.deepEqual(await runOk(vault, ['sync', 'binding']), { status: 'unbound', mode: null })
})

test('trigger, progress, rename-device and remove-device explain they need the desktop session', async () => {
  const vault = await makeVault()
  for (const args of [
    ['sync', 'trigger'],
    ['sync', 'rename-device', 'device_1', 'Desk'],
    ['sync', 'remove-device', 'device_1', '--yes']
  ]) {
    const result = await run(vault, args)
    assert.equal(result.code, 1, args.join(' '))
    assert.match(result.stderr, /needs the Memry desktop app/)
  }
  const progress = await run(vault, ['sync', 'progress'])
  assert.equal(progress.code, 1)
  assert.match(progress.stderr, /held in memory by the running Memry desktop app/)

  const noYes = await run(vault, ['sync', 'remove-device', 'device_1'])
  assert.equal(noYes.code, 1)
  assert.match(noYes.stderr, /--yes/)
  const noName = await run(vault, ['sync', 'rename-device', 'device_1'])
  assert.match(noName.stderr, /Missing new name/)
})
