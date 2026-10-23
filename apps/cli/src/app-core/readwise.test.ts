import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { settings } from '@memry/db-schema/data-schema'
import { readwiseLinks } from '@memry/db-schema/schema/readwise-links'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { READWISE_OPTIONS_DEFAULTS } from '@memry/contracts/import-channels'
import { eq } from 'drizzle-orm'

import { runCli } from '../run.ts'
import { openDatabases } from './database.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-readwise')
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
  callback: (db: ReturnType<typeof openDatabases>) => T
) {
  const databases = openDatabases(vaultPath)
  try {
    return callback(databases)
  } finally {
    databases.close()
  }
}

function putSetting(vaultPath: string, key: string, value: string) {
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb.insert(settings).values({ key, value, modifiedAt: new Date().toISOString() }).run()
  })
}

function readSetting(vaultPath: string, key: string): string | undefined {
  return withDatabases(
    vaultPath,
    ({ dataDb }) => dataDb.select().from(settings).where(eq(settings.key, key)).get()?.value
  )
}

interface Status {
  connected: null
  options: typeof READWISE_OPTIONS_DEFAULTS
  lastSyncAt: string | null
  needsAttention: boolean
  attention: string | null
  hasImported: boolean
  lastRun: Record<string, number> | null
  pullingDevice: { id: string; name: string | null; isThisDevice: boolean } | null
}

test('readwise status on a fresh vault reports desktop defaults and no run', async () => {
  const vaultPath = await makeVault()
  const status = await runOk<Status>(vaultPath, ['readwise', 'status'])
  assert.deepEqual(status.options, READWISE_OPTIONS_DEFAULTS)
  assert.equal(status.connected, null)
  assert.equal(status.hasImported, false)
  assert.equal(status.lastSyncAt, null)
  assert.equal(status.pullingDevice, null)
})

test('readwise status reads the run state and the claim desktop wrote', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  const counts = {
    books: 3,
    added: 2,
    updated: 1,
    appended: 0,
    deferred: 0,
    failed: 0,
    highlights: 9
  }
  putSetting(vaultPath, 'readwise.cursor', '2026-01-01T00:00:00Z')
  putSetting(
    vaultPath,
    'readwise.lastRun',
    JSON.stringify({ at: '2026-01-02T00:00:00Z', needsAttention: true, counts })
  )
  putSetting(
    vaultPath,
    'readwise',
    JSON.stringify({ cadence: 'daily', syncDeviceId: 'dev-1', syncDeviceName: 'Laptop' })
  )
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .insert(syncDevices)
      .values({
        id: 'dev-1',
        name: 'Laptop',
        platform: 'macos',
        appVersion: '1.0.0',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'k'
      })
      .run()
  })

  const status = await runOk<Status>(vaultPath, ['readwise', 'status'])
  assert.equal(status.hasImported, true)
  assert.equal(status.lastSyncAt, '2026-01-02T00:00:00Z')
  assert.equal(status.needsAttention, true)
  // A run parked by an older build has no kind: it read as a revoked token.
  assert.equal(status.attention, 'invalid-token')
  assert.deepEqual(status.lastRun, counts)
  assert.equal(status.options.cadence, 'daily')
  assert.equal(status.options.rootFolder, 'Readwise')
  assert.deepEqual(status.pullingDevice, { id: 'dev-1', name: 'Laptop', isThisDevice: true })
})

test('readwise set-options writes only the named fields and flags a full pass when a category turns on', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  putSetting(vaultPath, 'readwise', JSON.stringify({ syncDeviceId: 'dev-9', futureField: 1 }))

  const first = await runOk<Status>(vaultPath, [
    'readwise',
    'set-options',
    '--cadence',
    'manual',
    '--journal',
    'on'
  ])
  assert.equal(first.options.cadence, 'manual')
  assert.equal(first.options.journalHighlights, true)
  assert.equal(
    readSetting(vaultPath, 'readwise.fullPass'),
    undefined,
    'nothing switched on that needs a re-read'
  )
  // Fields the CLI does not model (a claim, a newer build's leaf) ride along untouched.
  const stored = JSON.parse(readSetting(vaultPath, 'readwise') ?? '{}') as Record<string, unknown>
  assert.equal(stored.syncDeviceId, 'dev-9')
  assert.equal(stored.futureField, 1)

  const second = await runOk<Status>(vaultPath, [
    'readwise',
    'set-options',
    '--category',
    'supplementals=on',
    '--category',
    'books=off',
    '--root-folder',
    '/Reading/'
  ])
  assert.equal(second.options.categories.supplementals, true)
  assert.equal(second.options.categories.books, false)
  assert.equal(second.options.rootFolder, 'Reading', 'the root folder is normalized like desktop')
  assert.equal(readSetting(vaultPath, 'readwise.fullPass'), 'true')

  // Switching a category off, or setting the same value again, needs no re-read.
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb.delete(settings).where(eq(settings.key, 'readwise.fullPass')).run()
  })
  await runOk(vaultPath, [
    'readwise',
    'set-options',
    '--category',
    'supplementals=on',
    '--category',
    'books=off'
  ])
  assert.equal(readSetting(vaultPath, 'readwise.fullPass'), undefined)
})

test('readwise set-options rejects bad input before writing', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  assert.match((await run(vaultPath, ['readwise', 'set-options'])).stderr, /Nothing to change/)
  assert.match(
    (await run(vaultPath, ['readwise', 'set-options', '--category', 'nope=on'])).stderr,
    /Unknown category/
  )
  assert.match(
    (await run(vaultPath, ['readwise', 'set-options', '--journal', 'maybe'])).stderr,
    /on or off/
  )
  assert.equal((await run(vaultPath, ['readwise', 'set-options', '--cadence', 'weekly'])).code, 1)
  assert.equal((await run(vaultPath, ['readwise', 'set-options', '--root-folder', '../x'])).code, 1)
  assert.equal(readSetting(vaultPath, 'readwise'), undefined)
})

test('readwise list-deleted lists the notes the user deleted, newest first', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  withDatabases(vaultPath, ({ dataDb }) => {
    dataDb
      .insert(readwiseLinks)
      .values([
        {
          readwiseBookId: 1,
          noteId: 'n1',
          state: 'note-deleted',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        {
          readwiseBookId: 2,
          noteId: 'n2',
          state: 'note-deleted',
          updatedAt: '2026-02-01T00:00:00.000Z'
        },
        { readwiseBookId: 3, noteId: 'n3', state: 'linked', updatedAt: '2026-03-01T00:00:00.000Z' },
        {
          readwiseBookId: 4,
          noteId: 'n4',
          state: 'source-deleted',
          updatedAt: '2026-03-01T00:00:00.000Z'
        }
      ])
      .run()
  })
  const deleted = await runOk<Array<{ readwiseBookId: number }>>(vaultPath, [
    'readwise',
    'list-deleted'
  ])
  assert.deepEqual(
    deleted.map((entry) => entry.readwiseBookId),
    [2, 1]
  )
})

test('readwise commands that need the desktop app say so and exit non-zero', async () => {
  const vaultPath = await makeVault()
  for (const command of [
    'sync-now',
    'restore-book',
    'reimport-book',
    'refresh-book',
    'take-over'
  ]) {
    const result = await run(vaultPath, ['readwise', command, '123'])
    assert.equal(result.code, 1, command)
    assert.match(result.stderr, new RegExp(`readwise ${command} runs in the desktop app`))
  }
  assert.match((await run(vaultPath, ['readwise', 'connect'])).stderr, /Usage: memrynote readwise/)
})
