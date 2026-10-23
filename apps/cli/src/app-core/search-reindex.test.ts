import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { sql } from 'drizzle-orm'
import { noteCache, noteTags } from '@memry/db-schema/index-schema'

import { openDatabases } from './database.ts'
import { createMemryApp, type MemryApp } from './memry-app.ts'
import { runCli } from '../run.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-search')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

// Desktop's indexer owns note_cache and note_tags; stand in for it so the FTS rebuild has rows.
function indexLikeDesktop(vaultPath: string, notes: MemryApp['notes'], ids: string[]) {
  return Promise.all(ids.map((id) => notes.get(id))).then((records) => {
    const databases = openDatabases(vaultPath)
    try {
      for (const note of records) {
        if (!note) throw new Error('note missing')
        databases.indexDb
          .insert(noteCache)
          .values({
            id: note.id,
            path: note.path,
            title: note.title,
            fileType: 'markdown',
            date: note.journalDate,
            createdAt: note.createdAt,
            modifiedAt: note.modifiedAt
          })
          .run()
        for (const tag of note.tags) {
          databases.indexDb.insert(noteTags).values({ noteId: note.id, tag }).run()
        }
      }
    } finally {
      databases.close()
    }
  })
}

async function seed() {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  const stemmed = await app.notes.create({
    title: 'Morning pages',
    content: 'She was running every morning before work.',
    folder: 'Health',
    tags: ['fitness']
  })
  const apart = await app.notes.create({
    title: 'Apart',
    content: 'zebra herd then a crossing guard, zebra stripes, crossing signs, zebra',
    folder: 'Zoo'
  })
  const adjacent = await app.notes.create({
    title: 'Adjacent',
    content: 'Long intro. The zebra crossing is on the corner.',
    folder: 'Zoo',
    tags: ['animals']
  })
  const project = await app.tasks.projects.create({ name: 'Safari' })
  await app.tasks.create({ title: 'Book zebra tour', projectId: project.id })
  await app.tasks.create({ title: 'Book zebra tour (inbox)' })
  await indexLikeDesktop(vaultPath, app.notes, [stemmed.id, apart.id, adjacent.id])
  const result = await app.vault.reindex()
  return { vaultPath, app, stemmed, apart, adjacent, project, result }
}

test('vault reindex rebuilds the FTS tables from the cache, files, tasks and inbox', async () => {
  const { vaultPath, app, result } = await seed()
  try {
    assert.equal(result.notes, 3)
    assert.equal(result.tasks, 2)
    assert.equal(result.skipped, 0)

    // A leftover row for a note that no longer exists must not survive a rebuild.
    const databases = openDatabases(vaultPath)
    try {
      databases.indexDb.run(
        sql`INSERT INTO fts_notes (id, title, content, tags) VALUES ('ghost', 'Ghost', 'zebra', '')`
      )
    } finally {
      databases.close()
    }
    await app.vault.reindex()
    const hits = await app.search('zebra', { types: ['note'] })
    assert.ok(!hits.some((hit) => hit.id === 'ghost'))
  } finally {
    app.close()
  }
})

test('search finds stemmed matches the substring scan cannot, and ranks the exact phrase first', async () => {
  const { app, stemmed, apart, adjacent } = await seed()
  try {
    const stem = await app.search('runs', { types: ['note'] })
    assert.deepEqual(
      stem.map((hit) => hit.id),
      [stemmed.id]
    )

    const phrase = await app.search('zebra crossing', { types: ['note'] })
    assert.deepEqual(phrase.map((hit) => hit.id).slice(0, 2), [adjacent.id, apart.id])
    assert.deepEqual(Object.keys(phrase[0]).sort(), ['id', 'kind', 'path', 'snippet', 'title'])
  } finally {
    app.close()
  }
})

test('search filters narrow by type, tag, folder, project, date and page', async () => {
  const { app, apart, adjacent, project } = await seed()
  try {
    assert.deepEqual(
      (await app.search('zebra', { types: ['task'] })).map((hit) => hit.kind),
      ['task', 'task']
    )
    assert.deepEqual(
      (await app.search('zebra', { tags: ['animals'] })).map((hit) => hit.id),
      [adjacent.id]
    )
    assert.deepEqual(
      (await app.search('zebra', { tags: ['animals'], folderPath: 'Zoo/' })).map((h) => h.id),
      [adjacent.id]
    )
    assert.deepEqual(
      (await app.search('zebra', { folderPath: 'Zoo/', types: ['note'] }))
        .map((hit) => hit.id)
        .sort(),
      [adjacent.id, apart.id].sort()
    )
    const tasks = await app.search('zebra', { projectId: project.id })
    assert.deepEqual(
      tasks.map((hit) => hit.title),
      ['Book zebra tour']
    )

    const future = await app.search('zebra', { from: '2999-01-01' })
    assert.deepEqual(future, [])
    const today = new Date().toISOString().slice(0, 10)
    assert.ok((await app.search('zebra', { from: today, to: today, types: ['note'] })).length >= 2)

    const all = await app.search('zebra', { types: ['note'] })
    const page = await app.search('zebra', { types: ['note'], limit: 1, offset: 1 })
    assert.deepEqual(
      page.map((hit) => hit.id),
      [all[1].id]
    )
  } finally {
    app.close()
  }
})

test('search keeps finding notes the FTS index has not seen', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    const note = await app.notes.create({ title: 'Fresh', content: 'quokka sighting' })
    assert.deepEqual(
      (await app.search('quokka')).map((hit) => hit.id),
      [note.id]
    )
  } finally {
    app.close()
  }
})

test('cli search flags reject bad values and apply filters', async () => {
  const { vaultPath, app, adjacent } = await seed()
  app.close()
  const run = async (args: string[]) => {
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runCli(['--vault', vaultPath, '--json', ...args], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    })
    return { code, stdout, stderr }
  }

  const ok = await run(['search', 'zebra', '--type', 'note', '--tag', 'animals', '--limit', '5'])
  assert.equal(ok.code, 0)
  assert.deepEqual(
    (JSON.parse(ok.stdout.at(-1) ?? '[]') as Array<{ id: string }>).map((hit) => hit.id),
    [adjacent.id]
  )

  const bad = await run(['search', 'zebra', '--type', 'bogus'])
  assert.equal(bad.code, 1)
  assert.match(bad.stderr.join('\n'), /Invalid --type/)
  assert.equal((await run(['search', 'zebra', '--limit', '0'])).code, 1)
})

test('vault set-icon, activity and locks work through the CLI', async () => {
  const vaultPath = await makeVault()
  const run = async (args: string[]) => {
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await runCli(['--vault', vaultPath, '--json', ...args], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    })
    return { code, stdout, stderr }
  }

  assert.equal((await run(['vault', 'set-icon', 'icon:Star'])).code, 0)
  const config = JSON.parse(
    await fs.readFile(path.join(vaultPath, '.memry', 'config.json'), 'utf-8')
  )
  assert.equal(config.vaultIcon.value, 'icon:Star')
  assert.equal(config.vaultIcon.pendingSync, true)
  const firstAt = config.vaultIcon.updatedAt as number
  assert.equal((await run(['vault', 'set-icon', 'null'])).code, 0)
  const reset = JSON.parse(
    await fs.readFile(path.join(vaultPath, '.memry', 'config.json'), 'utf-8')
  )
  assert.equal(reset.vaultIcon.value, null)
  assert.ok(reset.vaultIcon.updatedAt > firstAt)
  assert.ok(reset.defaultNoteFolder !== undefined, 'other config keys are kept')
  const badIcon = await run(['vault', 'set-icon', 'has space'])
  assert.equal(badIcon.code, 1)

  const lines = [
    {
      v: 1,
      id: 'a',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'added',
      source: 'watcher',
      path: 'a.md'
    },
    { v: 1, id: 'b', at: '2026-01-02T00:00:00.000Z', kind: 'failed', source: 'sync', path: 'b.md' }
  ]
  await fs.writeFile(
    path.join(vaultPath, '.memry', 'activity.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`
  )
  const all = await run(['vault', 'activity', 'list'])
  assert.deepEqual(
    (JSON.parse(all.stdout.at(-1) ?? '[]') as Array<{ id: string }>).map((entry) => entry.id),
    ['b', 'a']
  )
  const problems = await run(['vault', 'activity', 'list', '--problems'])
  assert.deepEqual(
    (JSON.parse(problems.stdout.at(-1) ?? '[]') as Array<{ id: string }>).map((entry) => entry.id),
    ['b']
  )
  assert.equal((await run(['vault', 'activity', 'clear'])).code, 1)
  assert.equal((await run(['vault', 'activity', 'clear', '--yes'])).code, 0)
  assert.deepEqual(JSON.parse((await run(['vault', 'activity', 'list'])).stdout.at(-1) ?? 'x'), [])

  const locks = await run(['vault', 'locks', 'list'])
  assert.deepEqual(JSON.parse(locks.stdout.at(-1) ?? '{}'), { notes: [], folders: [] })
  const set = await run(['vault', 'locks', 'set', 'note', 'abc'])
  assert.equal(set.code, 1)
  assert.match(set.stderr.join('\n'), /desktop app/)
})

test('vault remove needs --yes and a registry that can remove', async () => {
  const removed: string[] = []
  const registry = {
    listVaults: () => [],
    getDefaultVaultPath: () => null,
    setDefaultVaultPath: () => {
      throw new Error('unused')
    },
    removeVault: (reference: string) => {
      removed.push(reference)
      return { path: `/vaults/${reference}`, name: reference }
    }
  }
  const stdout: string[] = []
  const stderr: string[] = []
  const io = {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line)
  }

  assert.equal(await runCli(['vault', 'remove', 'work'], io, { vaultRegistry: registry }), 1)
  assert.deepEqual(removed, [])
  assert.equal(
    await runCli(['--json', 'vault', 'remove', 'work', '--yes'], io, { vaultRegistry: registry }),
    0
  )
  assert.deepEqual(removed, ['work'])

  const { removeVault: _unused, ...readOnly } = registry
  assert.equal(
    await runCli(['vault', 'remove', 'work', '--yes'], io, { vaultRegistry: readOnly }),
    1
  )
})

test('journal properties reports rows in range and the property summary', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.journal.write('2026-03-01', 'one')
    await app.journal.write('2026-03-02', 'two')
    await app.journal.write('2026-04-01', 'three')
    for (const [date, mood] of [
      ['2026-03-01', 4],
      ['2026-03-02', 5],
      ['2026-04-01', 3]
    ] as const) {
      const entry = await app.journal.get(date)
      assert.ok(entry)
      await app.properties.set(entry.id, { mood, done: true })
    }

    const result = await app.journal.properties('2026-03-01', '2026-03-31')
    assert.deepEqual(
      result.rows.map((row) => row.date),
      ['2026-03-01', '2026-03-02']
    )
    assert.equal(result.rows[0].properties.mood, 4)
    assert.deepEqual(
      result.properties.map((property) => [property.name, property.type, property.count]),
      [
        ['done', 'checkbox', 3],
        ['mood', 'number', 3]
      ]
    )
    await assert.rejects(app.journal.properties('March', '2026-03-31'), /Invalid from date/)
  } finally {
    app.close()
  }
})

test('settings groups cover desktop features, inbox, sticky, graphViews, tagSearches and sidebar', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    const names = (await app.settings.groups()).map((group) => group.name)
    for (const name of ['features', 'inbox', 'sticky', 'graphViews', 'tagSearches', 'sidebar']) {
      assert.ok(names.includes(name as never), name)
    }
    assert.equal((await app.settings.getGroup('features')).spatialCanvas, true)

    await app.settings.setGroup('sticky', { tuckEdge: 'left' })
    assert.equal((await app.settings.getGroup('sticky')).tuckEdge, 'left')
    assert.equal((await app.settings.getGroup('sticky')).defaultKind, 'last')

    // `sidebar` reads and writes desktop's per-key rows.
    await app.settings.setGroup('sidebar', { navCollapsed: true, sectionOrder: ['a', 'b'] })
    assert.deepEqual((await app.settings.get('sidebar.navCollapsed'))?.value, true)
    assert.deepEqual((await app.settings.get('sidebar.sectionOrder'))?.value, ['a', 'b'])
    const sidebar = await app.settings.getGroup('sidebar')
    assert.equal(sidebar.navCollapsed, true)
    assert.equal(sidebar.showFiles, true)
    await assert.rejects(app.settings.setGroup('sidebar', { navCollapsed: 'yes' }), /Invalid value/)
    await assert.rejects(app.settings.setGroup('sidebar', { nope: 1 }), /Unknown sidebar setting/)
  } finally {
    app.close()
  }
})
