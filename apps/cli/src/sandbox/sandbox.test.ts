import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'
import matter from 'gray-matter'

import { PropertyDefinitionsFileSchema } from '@memry/contracts/property-types'
import { TagSchemaWire, type TagSchemaStored } from '@memry/contracts/tag-schema'
import { ViewConfigSchema } from '@memry/contracts/folder-view-api'

import { generateSandbox } from './generate.ts'

// Links that point at no note on purpose, to show what an unresolved link looks like.
const UNRESOLVED_ON_PURPOSE = new Set(["Gene Kranz's white vest", 'A note I have not written yet'])

// Next Wednesday, 10:00 local: weekday-relative content is stable, and the
// date stays ahead of the wall clock that inbox.snooze validates against.
const today = new Date()
const NOW = new Date(
  today.getFullYear(),
  today.getMonth(),
  today.getDate() + ((10 - today.getDay()) % 7 || 7),
  10
)

async function markdownFiles(dir: string, root = dir): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'attachments') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await markdownFiles(full, root)))
    else if (entry.name.endsWith('.md'))
      files.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return files
}

test('sandbox generates a linked, populated vault', async () => {
  const root = path.join(process.cwd(), 'test-results', 'memry-sandbox')
  await fs.mkdir(root, { recursive: true })
  const vault = await fs.mkdtemp(path.join(root, `vault-${randomUUID()}-`))
  try {
    const counts = await generateSandbox(vault, NOW)
    assert.equal(counts.projects, 4)
    assert.equal(counts.canvases, 2)
    assert.ok(counts.notes >= 60, `notes: ${counts.notes}`)
    assert.ok(counts['journal entries'] >= 55, `journal: ${counts['journal entries']}`)
    assert.ok(counts.tasks >= 40, `tasks: ${counts.tasks}`)
    assert.ok(counts['inbox items'] >= 18, `inbox: ${counts['inbox items']}`)
    assert.equal(counts.files, 4)
    assert.equal(counts.versions, 3)
    assert.equal(counts['tags with fields'], 7)
    assert.equal(counts['tasks with fields'], 5)

    const data = new Database(path.join(vault, '.memry', 'data.db'), { readonly: true })
    try {
      const notes = data.prepare('SELECT id, path, title FROM note_metadata').all() as Array<{
        id: string
        path: string
        title: string
      }>
      const byPath = new Map(notes.map((note) => [note.path, note]))
      const canvasTitles = ['Aurora launch map', 'Space race essay board']
      const titles = new Set([
        ...notes.map((note) => note.title.toLowerCase()),
        ...canvasTitles.map((t) => t.toLowerCase())
      ])

      for (const relative of await markdownFiles(vault)) {
        const raw = await fs.readFile(path.join(vault, relative), 'utf8')
        const note = byPath.get(relative)
        assert.ok(note, `${relative} has note_metadata`)

        // Every wiki link resolves, except the deliberately missing notes.
        for (const [, target] of raw
          .replace(/`[^`\n]*`/g, '')
          .matchAll(/\[\[([^\]|#\\]*)(?:#[^\]|\\]*)?(?:\\?\|[^\]]*)?\]\]/g)) {
          if (target === '' || UNRESOLVED_ON_PURPOSE.has(target)) continue
          const name = target.split('/').pop()!.toLowerCase()
          assert.ok(titles.has(name), `${relative}: unresolved [[${target}]]`)
        }

        // Every task line is bound to a task row whose source is this note.
        for (const [, taskId] of raw.matchAll(/\{task:([^}]+)\}/g)) {
          const row = data.prepare('SELECT source_note_id FROM tasks WHERE id = ?').get(taskId) as
            { source_note_id: string } | undefined
          assert.equal(row?.source_note_id, note.id, `${relative}: {task:${taskId}}`)
        }

        // Embedded attachments exist where the note-relative reference points.
        for (const [, ref] of raw.matchAll(
          /(?:\]\(|src="|"url":")(\.\.\/[^)"]+|attachments\/[^)"]+)/g
        )) {
          const target = path.join(
            vault,
            path.dirname(relative),
            decodeURIComponent(ref.split('|')[0])
          )
          await fs.access(target).catch(() => assert.fail(`${relative}: missing attachment ${ref}`))
        }

        // Properties sit at the frontmatter root, where desktop reads them.
        assert.equal(matter(raw).data.properties, undefined, `${relative}: nested properties`)
      }

      // Done tasks sit in their project's done column.
      const misplaced = data
        .prepare(
          'SELECT count(*) FROM tasks t JOIN statuses s ON s.id = t.status_id WHERE t.completed_at IS NOT NULL AND s.is_done = 0'
        )
        .pluck()
        .get()
      assert.equal(misplaced, 0)

      // Canvas cards point at real rows.
      for (const file of ['Aurora/Aurora launch map', 'Essay/Space race essay board']) {
        const scene = JSON.parse(
          await fs.readFile(path.join(vault, 'canvases', `${file}.excalidraw`), 'utf8')
        )
        for (const element of scene.elements) {
          const { entityType, entityId } = element.customData ?? {}
          if (!entityType) continue
          const table = {
            note: 'note_metadata',
            file: 'note_metadata',
            task: 'tasks',
            project: 'projects',
            calendar_event: 'calendar_events'
          }[entityType as string]
          assert.ok(table, `unknown card type ${entityType}`)
          assert.ok(
            data.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(entityId),
            `${file}: dangling ${entityType} card`
          )
        }
      }

      const widgets = JSON.parse(
        data.prepare('SELECT widgets FROM home_pages').pluck().get() as string
      )
      assert.equal(widgets.length, 10)
      assert.equal(
        data.prepare("SELECT count(*) FROM vault_locks WHERE target_kind = 'note'").pluck().get(),
        1
      )
      assert.equal(data.prepare('SELECT count(*) FROM tag_categories').pluck().get(), 4)

      await assertTagsWithFields(vault, data, notes)
      await assertNotes101(vault)
    } finally {
      data.close()
    }

    const definitions = matter(
      await fs.readFile(path.join(vault, '.memry', 'properties.md'), 'utf8')
    ).data
    assert.ok(
      PropertyDefinitionsFileSchema.safeParse(definitions).success,
      'properties.md matches desktop schema'
    )
  } finally {
    await fs.rm(vault, { recursive: true, force: true })
  }
})

const MOVED_FROM_START_HERE = [
  'Editor tour',
  'Notes and links',
  'Properties and folder views',
  'Locks and version history',
  'Templates',
  'Bookmarks and reminders'
]

async function assertNotes101(vault: string): Promise<void> {
  const lessons = (await fs.readdir(path.join(vault, 'Notes 101'))).filter((n) =>
    /^\d\d .*\.md$/.test(n)
  )
  assert.equal(lessons.length, 14)
  for (const [index, name] of lessons.sort().entries()) {
    assert.ok(name.startsWith(String(index).padStart(2, '0') + ' '), `${name} is numbered in order`)
    const { data } = matter(await fs.readFile(path.join(vault, 'Notes 101', name), 'utf8'))
    assert.ok(data.summary && data.level, `${name} has summary and level for the folder view`)
  }
  const guide = await fs.readdir(path.join(vault, 'Start here'))
  for (const title of MOVED_FROM_START_HERE) {
    assert.ok(!guide.includes(`${title}.md`), `${title} moved out of Start here`)
  }
}

interface NoteRow {
  id: string
  path: string
  title: string
}

/** Schemas parse with the app's own wire schema, and every object's fields agree with them. */
async function assertTagsWithFields(
  vault: string,
  data: Database.Database,
  notes: NoteRow[]
): Promise<void> {
  const rows = data
    .prepare('SELECT name, schema, views FROM tag_definitions WHERE schema IS NOT NULL')
    .all() as Array<{ name: string; schema: string; views: string | null }>
  const schemas = new Map<string, TagSchemaStored>()
  for (const row of rows) {
    schemas.set(row.name, TagSchemaWire.parse(JSON.parse(row.schema)))
    for (const view of JSON.parse(row.views ?? '[]')) ViewConfigSchema.parse(view)
  }
  assert.deepEqual([...schemas.keys()].sort(), [
    'book',
    'client',
    'company',
    'meeting',
    'person',
    'recipe',
    'waiting'
  ])
  for (const preset of ['person', 'company', 'meeting', 'book']) {
    assert.equal(schemas.get(preset)?.preset, preset)
    assert.equal(schemas.get(preset)?.t, 1)
  }
  assert.equal(schemas.get('client')?.extends, 'company')

  const templateIds = new Set(
    (data.prepare('SELECT id FROM templates').all() as Array<{ id: string }>).map((r) => r.id)
  )
  const definitions = new Set(
    (data.prepare('SELECT name FROM property_definitions').all() as Array<{ name: string }>).map(
      (r) => r.name.toLowerCase()
    )
  )
  for (const [tag, schema] of schemas) {
    if (schema.template) assert.ok(templateIds.has(schema.template.id), `${tag} template exists`)
    for (const field of schema.fields ?? []) {
      if (field.relation) {
        assert.ok(schemas.has(field.relation.target ?? ''), `${tag}.${field.name} target tag`)
        assert.ok(
          !definitions.has(field.name.toLowerCase()),
          `${field.name}: relations have no definition`
        )
      } else {
        assert.ok(
          definitions.has(field.name.toLowerCase()),
          `${tag}.${field.name} has a definition`
        )
      }
    }
  }

  // Fields of a tag, with the ones it inherits.
  const fieldsOf = (tag: string): Map<string, { relation?: { target?: string | null } | null }> => {
    const fields = new Map<string, { relation?: { target?: string | null } | null }>()
    for (
      let current: string | null | undefined = tag;
      current;
      current = schemas.get(current)?.extends
    ) {
      for (const field of schemas.get(current)?.fields ?? []) fields.set(field.name, field)
    }
    return fields
  }
  const familyOf = (tag: string): string[] => [
    tag,
    ...[...schemas].filter(([, s]) => s.extends === tag).map(([name]) => name)
  ]

  const byId = new Map(notes.map((n) => [n.id, n]))
  const headerTags = new Map<string, string[]>()
  for (const note of notes) {
    const file = path.join(vault, note.path)
    if (!note.path.endsWith('.md')) continue
    const frontmatter = matter(await fs.readFile(file, 'utf8')).data
    headerTags.set(
      note.id,
      (frontmatter.tags ?? []).map((t: string) => t.toLowerCase())
    )
  }
  let objects = 0
  for (const note of notes) {
    if (!note.path.endsWith('.md')) continue
    const frontmatter = matter(await fs.readFile(path.join(vault, note.path), 'utf8')).data
    const tags = headerTags.get(note.id) ?? []
    const own = tags.filter((t) => schemas.has(t))
    if (own.length === 0) continue
    objects++
    const fields = new Map(own.flatMap((t) => [...fieldsOf(t)]))
    for (const [name, field] of fields) {
      const value = frontmatter[name]
      if (value === undefined || !field.relation) continue
      assert.ok(Array.isArray(value), `${note.path}: ${name} is a list of links`)
      for (const ref of value) {
        const target = byId.get(String(ref).replace('memry://note/', ''))
        assert.ok(target, `${note.path}: ${name} points at a note`)
        const wanted = field.relation.target ? familyOf(field.relation.target) : []
        assert.ok(
          (headerTags.get(target.id) ?? []).some((t) => wanted.includes(t)),
          `${note.path}: ${name} -> ${target.title} is not tagged ${field.relation.target}`
        )
      }
    }
    // A property of the same name in another case would be a second, clashing key.
    const keys = Object.keys(frontmatter).map((k) => k.toLowerCase())
    assert.equal(new Set(keys).size, keys.length, `${note.path}: duplicate property names`)
  }
  assert.ok(objects >= 30, `objects: ${objects}`)

  // Delegated tasks: the Waiting on field is a versioned map pointing at a person.
  const tasks = data
    .prepare(
      "SELECT t.id, t.fields FROM tasks t JOIN task_tags g ON g.task_id = t.id WHERE g.tag = 'waiting'"
    )
    .all() as Array<{ id: string; fields: string | null }>
  assert.equal(tasks.length, 5)
  for (const task of tasks) {
    const field = JSON.parse(task.fields ?? '{}')['Waiting on']
    assert.equal(field?.t, 1)
    const person = byId.get(String(field?.v?.[0]).replace('memry://note/', ''))
    assert.ok(
      person && headerTags.get(person.id)?.includes('person'),
      'Waiting on points at a person'
    )
  }
}
