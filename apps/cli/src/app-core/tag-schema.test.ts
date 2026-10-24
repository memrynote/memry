import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { eq } from 'drizzle-orm'
import { syncIntents, tagDefinitions } from '@memry/db-schema/data-schema'
import { noteCache, noteTags } from '@memry/db-schema/index-schema'
import { parseSchemaColumn, resolveTagSchemas } from '@memry/app-core/tag-schema'
import type { ResolvedTag } from '@memry/contracts/tag-schema'

import { openDatabases } from './database.ts'
import { createMemryApp } from './memry-app.ts'
import { runCli } from '../run.ts'

async function makeVault(): Promise<string> {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-tag-schema')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

async function cli(vaultPath: string, ...args: string[]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(['--vault', vaultPath, '--json', ...args], {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

async function cliJson<T>(vaultPath: string, ...args: string[]): Promise<T> {
  const result = await cli(vaultPath, ...args)
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout) as T
}

function withDb<T>(vaultPath: string, read: (dbs: ReturnType<typeof openDatabases>) => T): T {
  const dbs = openDatabases(vaultPath)
  try {
    return read(dbs)
  } finally {
    dbs.close()
  }
}

test('add-field stores the schema desktop reads, defines the property and queues a sync intent', async () => {
  const vault = await makeVault()
  const added = await cliJson<{ tag: string; changed: boolean; schema: ResolvedTag }>(
    vault,
    'tags',
    'schema',
    'add-field',
    'Person',
    'Company',
    '--type',
    'select',
    '--options',
    'Acme,Globex'
  )
  assert.equal(added.changed, true)
  assert.equal(added.tag, 'person')
  assert.deepEqual(
    added.schema.ownFields.map((f) => [f.name, f.type]),
    [['Company', 'select']]
  )

  withDb(vault, ({ dataDb }) => {
    const row = dataDb
      .select()
      .from(tagDefinitions)
      .all()
      .find((r) => r.name.toLowerCase() === 'person')
    assert.ok(row?.schema)
    // The column desktop's resolver reads: the shared module parses what the CLI wrote.
    const parsed = parseSchemaColumn(row.schema)
    assert.equal(parsed.kind, 'ok')
    const resolved = resolveTagSchemas(
      new Map([['person', { name: row.name, color: row.color, icon: row.icon, schema: parsed }]]),
      { get: () => undefined }
    )
    assert.equal(resolved.get('person')?.ownFields[0].name, 'Company')

    const intents = dataDb.select().from(syncIntents).all()
    assert.ok(
      intents.some((i) => i.type === 'tag_definition' && i.op === 'update' && i.itemId === row.name)
    )
    assert.ok(intents.some((i) => i.type === 'property_definition' && i.itemId === 'Company'))
  })

  const definitions = await cliJson<Array<{ name: string; type: string; options: string }>>(
    vault,
    'properties',
    'definitions'
  )
  const company = definitions.find((d) => d.name === 'Company')
  assert.equal(company?.type, 'select')
  assert.deepEqual(
    (JSON.parse(company.options) as Array<{ value: string }>).map((o) => o.value),
    ['Acme', 'Globex']
  )

  const shown = await cliJson<ResolvedTag>(vault, 'tags', 'schema', 'person')
  assert.equal(shown.hasFields, true)
  const snapshot = await cliJson<{ tags: Record<string, ResolvedTag> }>(vault, 'tags', 'schema')
  assert.deepEqual(Object.keys(snapshot.tags), ['person'])

  const duplicate = await cli(
    vault,
    'tags',
    'schema',
    'add-field',
    'person',
    'company',
    '--type',
    'text'
  )
  assert.equal(duplicate.code, 1)
  assert.match(duplicate.stderr, /already has a field/)
})

test('move-field, set-extends and cycles follow desktop rules; losing fields needs --yes', async () => {
  const vault = await makeVault()
  await cliJson(vault, 'tags', 'schema', 'add-field', 'person', 'Role', '--type', 'text')
  await cliJson(vault, 'tags', 'schema', 'add-field', 'person', 'Email', '--type', 'url')
  const moved = await cliJson<{ schema: ResolvedTag }>(
    vault,
    'tags',
    'schema',
    'move-field',
    'person',
    'Email',
    '0'
  )
  assert.deepEqual(
    moved.schema.ownFields.map((f) => f.name),
    ['Email', 'Role']
  )

  await cliJson(vault, 'tags', 'schema', 'add-field', 'employee', 'Salary', '--type', 'number')
  const extended = await cliJson<{ schema: ResolvedTag }>(
    vault,
    'tags',
    'schema',
    'set-extends',
    'employee',
    'person'
  )
  assert.deepEqual(
    extended.schema.effectiveFields.map((f) => f.name),
    ['Email', 'Role', 'Salary']
  )

  const related = await cliJson<{ schema: ResolvedTag }>(
    vault,
    'tags',
    'schema',
    'set-relation',
    'person',
    'Role',
    '--target',
    'company',
    '--many'
  )
  assert.deepEqual(related.schema.ownFields.find((f) => f.name === 'Role')?.relation, {
    target: 'company',
    many: true,
    inverse: null
  })
  const missingTemplate = await cli(vault, 'tags', 'schema', 'set-template', 'person', 'nope')
  assert.equal(missingTemplate.code, 1)
  assert.match(missingTemplate.stderr, /Template not found/)
  const template = await cliJson<{ id: string }>(vault, 'templates', 'create', 'Person page')
  const withTemplate = await cliJson<{ schema: ResolvedTag }>(
    vault,
    'tags',
    'schema',
    'set-template',
    'person',
    template.id,
    '--autofill'
  )
  assert.deepEqual(withTemplate.schema.template, {
    id: template.id,
    autofill: true,
    inheritedFrom: null
  })

  const cycle = await cli(vault, 'tags', 'schema', 'set-extends', 'person', 'employee')
  assert.equal(cycle.code, 1)
  assert.match(cycle.stderr, /already takes its fields from this tag/)

  const preview = await cliJson<{ kind: string; lost: string[] }>(
    vault,
    'tags',
    'impact',
    'set-extends',
    'employee',
    'none'
  )
  assert.deepEqual(preview.lost, ['Email', 'Role'])
  const refused = await cli(vault, 'tags', 'schema', 'set-extends', 'employee', 'none')
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /--yes/)
  const confirmed = await cliJson<{ schema: ResolvedTag }>(
    vault,
    'tags',
    'schema',
    'set-extends',
    'employee',
    'none',
    '--yes'
  )
  assert.equal(confirmed.schema.extends, null)
})

test('remove-field previews its impact, needs --yes, and rename-field / presets name the desktop', async () => {
  const vault = await makeVault()
  await cliJson(vault, 'tags', 'schema', 'add-field', 'person', 'Role', '--type', 'text')
  const app = await createMemryApp({ vaultPath: vault })
  try {
    await app.notes.create({
      title: 'Ada',
      tags: ['Person'],
      properties: { Role: 'Engineer' }
    })
    await app.notes.create({ title: 'Grace', tags: ['person'] })
    await app.notes.create({ title: 'Inline only', content: '#person but not in the header' })
  } finally {
    app.close()
  }

  const impact = await cliJson<{ filled: number; empty: number }>(
    vault,
    'tags',
    'impact',
    'remove-field',
    'person',
    'Role'
  )
  assert.deepEqual({ filled: impact.filled, empty: impact.empty }, { filled: 1, empty: 1 })
  assert.deepEqual(await cliJson(vault, 'tags', 'impact', 'become-objects', 'person'), {
    kind: 'become-objects',
    notes: 2
  })
  const del = await cliJson<{ notes: number; fields: number; values: number }>(
    vault,
    'tags',
    'impact',
    'delete-tag',
    'person'
  )
  assert.deepEqual(
    { notes: del.notes, fields: del.fields, values: del.values },
    { notes: 2, fields: 1, values: 1 }
  )

  const refused = await cli(vault, 'tags', 'schema', 'remove-field', 'person', 'Role')
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /--yes/)
  const removed = await cliJson<{ schema: ResolvedTag }>(
    vault,
    'tags',
    'schema',
    'remove-field',
    'person',
    'Role',
    '--yes'
  )
  assert.equal(removed.schema.ownFields.length, 0)

  for (const args of [
    ['schema', 'rename-field', 'person', 'Role', 'Job'],
    ['schema', 'add-preset', 'person'],
    ['fill-fields', 'person'],
    ['fill-status']
  ]) {
    const result = await cli(vault, 'tags', ...args)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /desktop app/)
  }
})

test('objects and linked-here read membership from the note headers and relation values', async () => {
  const vault = await makeVault()
  await cliJson(vault, 'tags', 'schema', 'add-field', 'company', 'Name', '--type', 'text')
  await cliJson(
    vault,
    'tags',
    'schema',
    'add-field',
    'person',
    'Employer',
    '--type',
    'relation',
    '--target',
    'company',
    '--inverse',
    'People'
  )
  await cliJson(vault, 'tags', 'schema', 'add-field', 'person', 'Role', '--type', 'text')
  const app = await createMemryApp({ vaultPath: vault })
  let acmeId: string
  try {
    const acme = await app.notes.create({ title: 'Acme', tags: ['company'] })
    acmeId = acme.id
    await app.notes.create({
      title: 'Ahmet Yilmaz',
      tags: ['Person'],
      properties: { Employer: [`memry://note/${acme.id}`], Role: 'Founder' }
    })
    await app.notes.create({ title: 'Plain note', tags: ['misc'] })
  } finally {
    app.close()
  }

  const found = await cliJson<{
    matches: Array<{ title: string; tag: string; subtitle: string[] }>
    complete: boolean
  }>(vault, 'tags', 'objects', '--query', 'ahm')
  assert.deepEqual(
    found.matches.map((m) => [m.title, m.tag, m.subtitle]),
    [['Ahmet Yilmaz', 'person', ['Founder', 'Acme']]]
  )
  const scoped = await cliJson<{ matches: Array<{ title: string }> }>(
    vault,
    'tags',
    'objects',
    'company'
  )
  assert.deepEqual(
    scoped.matches.map((m) => m.title),
    ['Acme']
  )

  const groups = await cliJson<
    Array<{
      kind: string
      label?: string
      field?: string
      total: number
      items: Array<{ title: string }>
    }>
  >(vault, 'tags', 'linked-here', acmeId)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'relation')
  assert.equal(groups[0].label, 'People')
  assert.equal(groups[0].field, 'Employer')
  assert.deepEqual(
    groups[0].items.map((i) => i.title),
    ['Ahmet Yilmaz']
  )
})

test('categories, icon and reorder persist, queue sync intents and keep names unique per call', async () => {
  const vault = await makeVault()
  const work = await cliJson<{ id: string; name: string; sortOrder: number }>(
    vault,
    'tags',
    'categories',
    'create',
    'Work'
  )
  const home = await cliJson<{ id: string; sortOrder: number }>(
    vault,
    'tags',
    'categories',
    'create',
    'Home'
  )
  assert.deepEqual([work.sortOrder, home.sortOrder], [0, 1])
  await cliJson(vault, 'tags', 'categories', 'rename', work.id, 'Job')
  await cliJson(vault, 'tags', 'categories', 'reorder', home.id, work.id)

  await cliJson(vault, 'tags', 'set-icon', 'Ünal', '🚀')
  await cliJson(vault, 'tags', 'set-icon', 'other', '📌')
  const reordered = await cliJson<{
    tags: Array<{ tag: string; categoryId: string | null; sortOrder: number }>
  }>(vault, 'tags', 'reorder', 'ünal', 'other', '--category', work.id)
  assert.deepEqual(
    reordered.tags.map((t) => [t.tag, t.categoryId, t.sortOrder]),
    [
      ['ünal', work.id, 0],
      ['other', work.id, 1]
    ]
  )

  const listed = await cliJson<Array<{ name: string; tagCount: number; sortOrder: number }>>(
    vault,
    'tags',
    'categories'
  )
  assert.deepEqual(
    listed.map((c) => [c.name, c.tagCount, c.sortOrder]),
    [
      ['Home', 0, 0],
      ['Job', 2, 1]
    ]
  )

  withDb(vault, ({ dataDb }) => {
    // One row per fold-equal tag: `ünal` addressed the row written as `Ünal`.
    const rows = dataDb.select().from(tagDefinitions).all()
    assert.equal(rows.filter((r) => r.name.toLowerCase() === 'ünal').length, 1)
    assert.equal(rows.find((r) => r.name === 'Ünal')?.icon, '🚀')
    assert.ok(
      dataDb.select().from(syncIntents).where(eq(syncIntents.type, 'tag_category')).all().length >=
        4
    )
  })

  const refused = await cli(vault, 'tags', 'categories', 'delete', work.id)
  assert.equal(refused.code, 1)
  await cliJson(vault, 'tags', 'categories', 'delete', work.id, '--yes')
  assert.equal((await cliJson<unknown[]>(vault, 'tags', 'categories')).length, 1)
  withDb(vault, ({ dataDb }) => {
    assert.equal(
      dataDb
        .select()
        .from(tagDefinitions)
        .all()
        .find((r) => r.name === 'Ünal')?.categoryId,
      null
    )
  })

  await cliJson(vault, 'tags', 'set-icon', 'other', '--clear')
  const missing = await cli(vault, 'tags', 'categories', 'rename', 'nope', 'X')
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /not found/)
})

test('pin writes the index row desktop reads and refuses a note the index has not seen', async () => {
  const vault = await makeVault()
  const app = await createMemryApp({ vaultPath: vault })
  let noteId: string
  try {
    noteId = (await app.notes.create({ title: 'Pinned', tags: ['Work'] })).id
  } finally {
    app.close()
  }

  const notIndexed = await cli(vault, 'tags', 'pin', 'work', noteId)
  assert.equal(notIndexed.code, 1)
  assert.match(notIndexed.stderr, /desktop app/)

  withDb(vault, ({ indexDb }) => {
    const now = new Date().toISOString()
    indexDb
      .insert(noteCache)
      .values({
        id: noteId,
        path: 'notes/pinned.md',
        title: 'Pinned',
        createdAt: now,
        modifiedAt: now
      })
      .run()
    indexDb.insert(noteTags).values({ noteId, tag: 'Work', position: 0, inHeader: true }).run()
  })
  await cliJson(vault, 'tags', 'pin', 'work', noteId)
  withDb(vault, ({ indexDb }) => {
    const row = indexDb.select().from(noteTags).where(eq(noteTags.noteId, noteId)).get()
    assert.ok(row?.pinnedAt)
  })
  await cliJson(vault, 'tags', 'unpin', 'work', noteId)
  withDb(vault, ({ indexDb }) => {
    assert.equal(
      indexDb.select().from(noteTags).where(eq(noteTags.noteId, noteId)).get()?.pinnedAt,
      null
    )
  })

  const wrongTag = await cli(vault, 'tags', 'pin', 'other', noteId)
  assert.equal(wrongTag.code, 1)
  assert.match(wrongTag.stderr, /does not have the tag/)
})
