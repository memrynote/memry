import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { eq } from 'drizzle-orm'
import { noteMetadata, projectLinks, projects, syncIntents } from '@memry/db-schema/data-schema'

import {
  readProjectNames,
  titleFromUrl,
  urlCaptureNote,
  withProjectName,
  withoutProjectName
} from './project-links.ts'
import {
  captureUrlToProject,
  titleFromUrl as desktopTitleFromUrl
} from '../../../desktop/src/main/tasks/capture-url.ts'
import {
  readProjectNames as desktopReadProjectNames,
  withProjectName as desktopWithProjectName,
  withoutProjectName as desktopWithoutProjectName
} from '../../../desktop/src/main/notes/project-property.ts'
import { openDatabases } from './database.ts'
import { createMemryApp } from './memry-app.ts'
import { runCli } from '../run.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-project-links')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

async function cli(vaultPath: string, args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

async function json<T>(vaultPath: string, args: string[]): Promise<T> {
  const result = await cli(vaultPath, args)
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout) as T
}

test('project frontmatter and URL-capture helpers behave like desktop', async () => {
  const shapes: unknown[] = [
    ['Alpha', ' beta ', 'ALPHA', '', 3],
    'Solo',
    '["Json", "List"]',
    '[not json',
    null,
    undefined,
    ''
  ]
  for (const shape of shapes) {
    const properties = { project: shape }
    assert.deepEqual(readProjectNames(properties), desktopReadProjectNames(properties))
  }
  assert.deepEqual(withProjectName(['A'], 'a'), desktopWithProjectName(['A'], 'a'))
  assert.deepEqual(withProjectName(['A'], 'B'), desktopWithProjectName(['A'], 'B'))
  assert.deepEqual(withoutProjectName(['A', 'b'], 'B'), desktopWithoutProjectName(['A', 'b'], 'B'))

  for (const url of ['https://example.com/', 'https://example.com/a/b/', 'not a url']) {
    assert.equal(titleFromUrl(url), desktopTitleFromUrl(url))
  }

  for (const [url, title] of [
    ['https://example.com/Foo_(bar)', 'A [weird] title'],
    ['https://example.com/x', null],
    ['https://example.com/a b', '  Padded  ']
  ] as const) {
    let captured: { title: string; content: string } | undefined
    await captureUrlToProject(
      {
        fetchTitle: async () => title,
        createNote: async (note) => {
          captured = note
          return { id: 'n1' }
        },
        linkToProject: async () => {}
      },
      { projectId: 'p', url }
    )
    assert.deepEqual(urlCaptureNote(url, title), captured)
  }
})

test('projects link, links, for-item, contents and unlink round-trip a note through its frontmatter', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  const project = await app.tasks.projects.create({ name: 'Garden' })
  const note = await app.notes.create({
    title: 'Soil notes',
    content: 'Loam.',
    properties: { mood: 'ok' }
  })
  app.close()

  assert.deepEqual(
    await json(vaultPath, ['projects', 'link', project.id, '--note', note.id, '--pin']),
    {
      success: true
    }
  )

  const reopened = await createMemryApp({ vaultPath })
  try {
    const properties = await reopened.properties.get(note.id)
    assert.deepEqual(properties.project, ['Garden'])
    assert.equal(properties.mood, 'ok')
  } finally {
    reopened.close()
  }

  const links = await json<Array<{ itemId: string; itemType: string }>>(vaultPath, [
    'projects',
    'links',
    project.id
  ])
  assert.deepEqual(
    links.map((link) => [link.itemType, link.itemId]),
    [['note', note.id]]
  )

  const forItem = await json<Array<{ id: string; name: string }>>(vaultPath, [
    'projects',
    'for-item',
    '--note',
    note.id
  ])
  assert.deepEqual(
    forItem.map((ref) => ref.name),
    ['Garden']
  )

  const contents = await json<{
    notes: Array<{ id: string; pinned: boolean }>
    counts: { notes: number; files: number; events: number }
  }>(vaultPath, ['projects', 'contents', project.id])
  assert.deepEqual(
    contents.notes.map((entry) => [entry.id, entry.pinned]),
    [[note.id, true]]
  )
  assert.deepEqual(contents.counts, { notes: 1, files: 0, events: 0 })

  const onlyFiles = await json<{ notes: unknown[]; counts: { notes: number } }>(vaultPath, [
    'projects',
    'contents',
    project.id,
    '--type',
    'file,event'
  ])
  assert.deepEqual(onlyFiles.notes, [])
  assert.equal(onlyFiles.counts.notes, 0)

  await json(vaultPath, ['projects', 'unpin', project.id, note.id])
  const unpinned = await json<{ notes: Array<{ pinned: boolean }> }>(vaultPath, [
    'projects',
    'contents',
    project.id
  ])
  assert.equal(unpinned.notes[0].pinned, false)

  await json(vaultPath, ['projects', 'unlink', project.id, '--note', note.id])
  const after = await createMemryApp({ vaultPath })
  try {
    assert.deepEqual((await after.properties.get(note.id)).project, [])
  } finally {
    after.close()
  }
  assert.deepEqual(await json(vaultPath, ['projects', 'links', project.id]), [])
})

test('projects link writes table-native links, owes a project sync update, and rejects bad targets', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  const project = await app.tasks.projects.create({ name: 'Files' })
  app.close()

  const databases = openDatabases(vaultPath)
  try {
    databases.dataDb
      .insert(noteMetadata)
      .values({
        id: 'file-1',
        path: 'Attachments/plan.pdf',
        title: 'plan',
        fileType: 'pdf',
        createdAt: '2026-10-01T00:00:00.000Z',
        modifiedAt: '2026-10-01T00:00:00.000Z'
      })
      .run()
  } finally {
    databases.close()
  }

  await json(vaultPath, ['projects', 'link', project.id, '--file', 'file-1'])
  await json(vaultPath, ['projects', 'link', project.id, '--file', 'file-1'])

  const contents = await json<{ files: Array<{ id: string; fileType: string }> }>(vaultPath, [
    'projects',
    'contents',
    project.id
  ])
  assert.deepEqual(
    contents.files.map((file) => [file.id, file.fileType]),
    [['file-1', 'pdf']]
  )

  const check = openDatabases(vaultPath)
  try {
    assert.equal(check.dataDb.select().from(projectLinks).all().length, 1)
    const intents = check.dataDb.select().from(syncIntents).all()
    assert.ok(intents.length >= 1)
    for (const intent of intents) {
      assert.equal(intent.type, 'project')
      assert.equal(intent.itemId, project.id)
      assert.equal(intent.op, 'update')
      assert.deepEqual(JSON.parse(intent.args), [['links']])
    }
  } finally {
    check.close()
  }

  const missingProject = await cli(vaultPath, ['projects', 'link', 'nope', '--file', 'file-1'])
  assert.equal(missingProject.code, 1)
  assert.match(missingProject.stderr, /Project not found/)
  const missingEvent = await cli(vaultPath, ['projects', 'link', project.id, '--event', 'ev-x'])
  assert.equal(missingEvent.code, 1)
  assert.match(missingEvent.stderr, /Calendar event not found/)
  const noType = await cli(vaultPath, ['projects', 'link', project.id])
  assert.equal(noType.code, 1)
  assert.match(noType.stderr, /exactly one of/)

  await json(vaultPath, ['projects', 'unlink', project.id, '--file', 'file-1'])
  assert.deepEqual(await json(vaultPath, ['projects', 'links', project.id]), [])
})

test('projects set-home-note sets and clears the home note', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  const project = await app.tasks.projects.create({ name: 'Home' })
  const note = await app.notes.create({ title: 'Hub' })
  app.close()

  await json(vaultPath, ['projects', 'set-home-note', project.id, note.id])
  const databases = openDatabases(vaultPath)
  try {
    const row = databases.dataDb.select().from(projects).where(eq(projects.id, project.id)).get()
    assert.equal(row?.homeNoteId, note.id)
    const intents = databases.dataDb.select().from(syncIntents).all()
    assert.deepEqual(JSON.parse(intents.at(-1)?.args ?? '[]'), [['homeNoteId']])
  } finally {
    databases.close()
  }

  await json(vaultPath, ['projects', 'set-home-note', project.id, 'null'])
  const cleared = openDatabases(vaultPath)
  try {
    assert.equal(
      cleared.dataDb.select().from(projects).where(eq(projects.id, project.id)).get()?.homeNoteId,
      null
    )
  } finally {
    cleared.close()
  }

  const bad = await cli(vaultPath, ['projects', 'set-home-note', project.id, 'missing-note'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr, /Note not found/)
})

test('projects capture-url creates a linked note and falls back to the URL when the page is unreachable', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  const project = await app.tasks.projects.create({ name: 'Reading' })
  app.close()

  const captured = await json<{ success: boolean; noteId: string }>(vaultPath, [
    'projects',
    'capture-url',
    project.id,
    'http://127.0.0.1:1/some/page'
  ])
  assert.equal(captured.success, true)

  const reopened = await createMemryApp({ vaultPath })
  try {
    const note = await reopened.notes.get(captured.noteId)
    assert.equal(note?.title, '127.0.0.1:1/some/page')
    assert.match(
      note?.content ?? '',
      /\[http:\/\/127\.0\.0\.1:1\/some\/page\]\(http:\/\/127\.0\.0\.1:1\/some\/page\)/
    )
    assert.deepEqual((await reopened.properties.get(captured.noteId)).project, ['Reading'])
  } finally {
    reopened.close()
  }
})

test('projects import-files links imported markdown and reports files that have no id yet', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  const project = await app.tasks.projects.create({ name: 'Imports' })
  app.close()

  const sourceDir = path.join(vaultPath, '..', `src-${randomUUID()}`)
  await fs.mkdir(sourceDir, { recursive: true })
  const markdown = path.join(sourceDir, 'imported.md')
  const pdf = path.join(sourceDir, 'scan.pdf')
  await fs.writeFile(markdown, '# Imported\n\nBody.\n')
  await fs.writeFile(pdf, '%PDF-1.4\n')

  const ok = await json<{ success: boolean; linked: string[]; failed: unknown[] }>(vaultPath, [
    'projects',
    'import-files',
    project.id,
    markdown
  ])
  assert.equal(ok.success, true)
  assert.equal(ok.linked.length, 1)
  assert.deepEqual(ok.failed, [])

  const partial = await cli(vaultPath, ['projects', 'import-files', project.id, pdf])
  assert.equal(partial.code, 1)
  const report = JSON.parse(partial.stdout) as {
    linked: string[]
    failed: Array<{ error: string }>
  }
  assert.deepEqual(report.linked, [])
  assert.match(report.failed[0].error, /no id yet/)

  const links = await json<unknown[]>(vaultPath, ['projects', 'links', project.id])
  assert.equal(links.length, 1)
})
