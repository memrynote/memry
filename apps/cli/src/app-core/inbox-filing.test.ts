import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { eq } from 'drizzle-orm'
import { inboxItems } from '@memry/db-schema/data-schema'

import { runCli } from '../run.ts'
import { openDatabases } from './database.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-inbox-filing')
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

async function capture(vaultPath: string, content: string, ...extra: string[]) {
  return runOk<{ id: string }>(vaultPath, ['inbox', 'capture', content, ...extra])
}

function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

test('inbox file turns a text item into a note in the folder, records history, and undo reopens it', async () => {
  const vault = await makeVault()
  const item = await capture(vault, 'Buy oat milk', '--title', 'Groceries', '--tag', 'home')

  const filed = await runOk<{ success: boolean; filedTo: string; noteId: string }>(vault, [
    'inbox',
    'file',
    item.id,
    '--folder',
    'Lists',
    '--tag',
    'weekly'
  ])
  assert.equal(filed.success, true)
  assert.match(filed.filedTo, /^Lists\//)
  const body = await fs.readFile(path.join(vault, filed.filedTo), 'utf-8')
  assert.match(body, /Buy oat milk/)
  assert.match(body, /Filed from Inbox/)

  const note = await runOk<{ tags: string[] }>(vault, ['notes', 'get', filed.noteId])
  assert.deepEqual([...note.tags].sort(), ['home', 'inbox', 'weekly'])

  const history = await runOk<{ entries: Array<{ itemId: string; filedAction: string }> }>(vault, [
    'inbox',
    'filing-history'
  ])
  assert.equal(history.entries[0]?.itemId, item.id)
  assert.equal(history.entries[0]?.filedAction, 'folder')

  const again = await run(vault, ['inbox', 'file', item.id, '--folder', 'Lists'])
  assert.equal(again.code, 1)
  assert.match(again.stderr, /already been filed/)

  await runOk(vault, ['inbox', 'undo', 'file', item.id])
  const reopened = await runOk<{ filedAt: string | null; filedTo: string | null }>(vault, [
    'inbox',
    'get',
    item.id
  ])
  assert.equal(reopened.filedAt, null)
  assert.equal(reopened.filedTo, null)
  const notFiled = await run(vault, ['inbox', 'undo', 'file', item.id])
  assert.equal(notFiled.code, 1)
  assert.match(notFiled.stderr, /not filed/)
})

test('inbox file moves a binary capture into the folder and removes the inbox copy', async () => {
  const vault = await makeVault()
  const source = path.join(vault, 'shot.png')
  await fs.writeFile(source, 'png-bytes')
  const item = await runOk<{ id: string; attachmentPath: string }>(vault, [
    'inbox',
    'capture-image',
    source,
    '--title',
    'Whiteboard'
  ])
  assert.ok(await fs.stat(path.join(vault, item.attachmentPath)))

  const filed = await runOk<{ filedTo: string }>(vault, [
    'inbox',
    'file',
    item.id,
    '--folder',
    'Pictures'
  ])
  assert.equal(filed.filedTo, 'Pictures/Whiteboard.png')
  assert.equal(await fs.readFile(path.join(vault, filed.filedTo), 'utf-8'), 'png-bytes')
  await assert.rejects(fs.stat(path.join(vault, item.attachmentPath)))
})

test('inbox file refuses a folder outside the vault and a missing --folder', async () => {
  const vault = await makeVault()
  const item = await capture(vault, 'x')
  const escaping = await run(vault, ['inbox', 'file', item.id, '--folder', '../outside'])
  assert.equal(escaping.code, 1)
  assert.match(escaping.stderr, /inside the vault/)
  const missing = await run(vault, ['inbox', 'file', item.id])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /Missing --folder/)
})

test('bulk-file reports per-item failures and exits non-zero', async () => {
  const vault = await makeVault()
  const first = await capture(vault, 'one')
  const second = await capture(vault, 'two')
  const ok = await runOk<{ processedCount: number; success: boolean }>(vault, [
    'inbox',
    'bulk-file',
    first.id,
    second.id,
    '--folder',
    'Batch'
  ])
  assert.equal(ok.processedCount, 2)

  const partial = await run(vault, ['inbox', 'bulk-file', first.id, '--folder', 'Batch'])
  assert.equal(partial.code, 1)
  const parsed = JSON.parse(partial.stdout) as { errors: Array<{ itemId: string }> }
  assert.equal(parsed.errors[0]?.itemId, first.id)
})

test('file-all-stale needs --yes and files only items older than the threshold', async () => {
  const vault = await makeVault()
  const stale = await capture(vault, 'old thought')
  const fresh = await capture(vault, 'new thought')
  const databases = openDatabases(vault)
  try {
    databases.dataDb
      .update(inboxItems)
      .set({ createdAt: '2020-01-01T00:00:00.000Z' })
      .where(eq(inboxItems.id, stale.id))
      .run()
  } finally {
    databases.close()
  }

  const refused = await run(vault, ['inbox', 'file-all-stale'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /--yes/)

  const result = await runOk<{ processedCount: number }>(vault, [
    'inbox',
    'file-all-stale',
    '--yes'
  ])
  assert.equal(result.processedCount, 1)
  const staleItem = await runOk<{ filedTo: string }>(vault, ['inbox', 'get', stale.id])
  assert.match(staleItem.filedTo, /^Unsorted\//)
  const freshItem = await runOk<{ filedAt: string | null }>(vault, ['inbox', 'get', fresh.id])
  assert.equal(freshItem.filedAt, null)
})

test('convert-event creates a calendar event and files the item', async () => {
  const vault = await makeVault()
  const item = await capture(vault, 'Dentist next week', '--title', 'Dentist')
  const start = futureIso(7)
  const result = await runOk<{ eventId: string }>(vault, [
    'inbox',
    'convert-event',
    item.id,
    '--start',
    start,
    '--location',
    'Main St'
  ])
  const event = await runOk<{ title: string; startAt: string; location: string }>(vault, [
    'calendar',
    'events',
    'get',
    result.eventId
  ])
  assert.equal(event.title, 'Dentist')
  assert.equal(event.startAt, start)
  assert.equal(event.location, 'Main St')
  const filed = await runOk<{ filedAction: string; filedTo: string }>(vault, [
    'inbox',
    'get',
    item.id
  ])
  assert.equal(filed.filedAction, 'event')
  assert.equal(filed.filedTo, result.eventId)
})

test('convert-event rejects image items and a missing --start', async () => {
  const vault = await makeVault()
  const source = path.join(vault, 'a.png')
  await fs.writeFile(source, 'x')
  const image = await runOk<{ id: string }>(vault, ['inbox', 'capture-image', source])
  const refused = await run(vault, ['inbox', 'convert-event', image.id, '--start', futureIso(1)])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /Only text and voice/)
  const text = await capture(vault, 'x')
  const missing = await run(vault, ['inbox', 'convert-event', text.id])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /Missing --start/)
})

test('convert-reminder makes a note with a reminder and rejects past times', async () => {
  const vault = await makeVault()
  const item = await capture(vault, 'Call mom', '--title', 'Call mom')
  const past = await run(vault, [
    'inbox',
    'convert-reminder',
    item.id,
    '--at',
    '2020-01-01T09:00:00.000Z'
  ])
  assert.equal(past.code, 1)
  assert.match(past.stderr, /in the future/)

  const at = futureIso(2)
  const result = await runOk<{ noteId: string }>(vault, [
    'inbox',
    'convert-reminder',
    item.id,
    '--at',
    at
  ])
  const reminders = await runOk<Array<{ targetId: string; remindAt: string }>>(vault, [
    'reminders',
    'for-target',
    'note',
    result.noteId
  ])
  assert.equal(reminders[0]?.remindAt, at)
  const filed = await runOk<{ filedAction: string }>(vault, ['inbox', 'get', item.id])
  assert.equal(filed.filedAction, 'reminder')
})

test('suggestions rank folders by where similar items were filed before', async () => {
  const vault = await makeVault()
  for (const text of ['a', 'b', 'c']) {
    const item = await capture(vault, text)
    await runOk(vault, ['inbox', 'file', item.id, '--folder', text === 'c' ? 'Misc' : 'Reading'])
  }
  const target = await capture(vault, 'next')
  const { suggestions } = await runOk<{
    suggestions: Array<{ destination: { path: string }; confidence: number }>
  }>(vault, ['inbox', 'suggestions', target.id])
  assert.equal(suggestions[0]?.destination.path, 'Reading')
  assert.equal(suggestions[0]?.confidence, 0.67)
  assert.equal(suggestions[1]?.destination.path, 'Misc')

  const missing = await run(vault, ['inbox', 'suggestions', 'inbox_missing'])
  assert.equal(missing.code, 1)
})

test('undo archive restores an archived item and refuses one that is not archived', async () => {
  const vault = await makeVault()
  const item = await capture(vault, 'later')
  const notArchived = await run(vault, ['inbox', 'undo', 'archive', item.id])
  assert.equal(notArchived.code, 1)
  assert.match(notArchived.stderr, /not archived/)
  await runOk(vault, ['inbox', 'archive', item.id])
  await runOk(vault, ['inbox', 'undo', 'archive', item.id])
  const restored = await runOk<{ archivedAt: string | null }>(vault, ['inbox', 'get', item.id])
  assert.equal(restored.archivedAt, null)
  const badAction = await run(vault, ['inbox', 'undo', 'snooze', item.id])
  assert.equal(badAction.code, 1)
})

test('capture-pdf and capture-voice validate the file type; voice queues a transcription job', async () => {
  const vault = await makeVault()
  const pdf = path.join(vault, 'paper.pdf')
  const audio = path.join(vault, 'memo.m4a')
  const text = path.join(vault, 'notes.txt')
  await fs.writeFile(pdf, '%PDF')
  await fs.writeFile(audio, 'audio')
  await fs.writeFile(text, 'hi')

  const savedPdf = await runOk<{ type: string }>(vault, ['inbox', 'capture-pdf', pdf])
  assert.equal(savedPdf.type, 'pdf')
  const wrong = await run(vault, ['inbox', 'capture-pdf', text])
  assert.equal(wrong.code, 1)
  assert.match(wrong.stderr, /Unsupported pdf file/)
  const wrongVoice = await run(vault, ['inbox', 'capture-voice', pdf])
  assert.equal(wrongVoice.code, 1)

  const voice = await runOk<{ id: string; type: string; transcriptionStatus?: string }>(vault, [
    'inbox',
    'capture-voice',
    audio
  ])
  assert.equal(voice.type, 'voice')
  const { jobs } = await runOk<{ jobs: Array<{ itemId: string; type: string; status: string }> }>(
    vault,
    ['inbox', 'jobs', '--item', voice.id]
  )
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]?.type, 'transcription')
  assert.equal(jobs[0]?.status, 'pending')

  const second = path.join(vault, 'memo2.m4a')
  await fs.writeFile(second, 'audio')
  const untranscribed = await runOk<{ id: string }>(vault, [
    'inbox',
    'capture-voice',
    second,
    '--transcribe',
    'false'
  ])
  const none = await runOk<{ jobs: unknown[] }>(vault, [
    'inbox',
    'jobs',
    '--item',
    untranscribed.id
  ])
  assert.equal(none.jobs.length, 0)
})

test('retry re-queues a failed link scrape and rejects items that cannot retry', async () => {
  const vault = await makeVault()
  const link = await runOk<{ id: string }>(vault, [
    'inbox',
    'capture-link',
    'https://example.com/a'
  ])
  const databases = openDatabases(vault)
  try {
    databases.dataDb
      .update(inboxItems)
      .set({ processingStatus: 'failed', processingError: 'boom' })
      .where(eq(inboxItems.id, link.id))
      .run()
  } finally {
    databases.close()
  }
  await runOk(vault, ['inbox', 'retry', link.id])
  const item = await runOk<{ processingStatus: string }>(vault, ['inbox', 'get', link.id])
  assert.equal(item.processingStatus, 'pending')
  const { jobs } = await runOk<{
    jobs: Array<{ type: string; status: string; payload: { url: string } }>
  }>(vault, ['inbox', 'jobs', '--status', 'pending'])
  assert.equal(jobs[0]?.type, 'metadata-scrape')
  assert.equal(jobs[0]?.payload.url, 'https://example.com/a')
  // A second retry reuses the job instead of stacking another.
  await runOk(vault, ['inbox', 'retry', link.id])
  const again = await runOk<{ jobs: unknown[] }>(vault, ['inbox', 'jobs', '--item', link.id])
  assert.equal(again.jobs.length, 1)

  const text = await capture(vault, 'plain')
  const refused = await run(vault, ['inbox', 'retry', text.id])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /Only link and voice/)
})
