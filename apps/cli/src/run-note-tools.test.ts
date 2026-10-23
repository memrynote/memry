import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { runCli } from './run.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-run-note-tools')
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

async function ok<T = unknown>(vaultPath: string, ...args: string[]): Promise<T> {
  const result = await cli(vaultPath, ...args)
  assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`)
  return JSON.parse(result.stdout) as T
}

type Note = { id: string; path: string; title: string; content: string }

test('notes aliases / resolve / unlinked-mentions / link-mention through the CLI', async () => {
  const vault = await makeVault()
  const target = await ok<Note>(vault, 'notes', 'create', 'Project Atlas')
  const source = await ok<Note>(vault, 'notes', 'create', 'Standup', '--content', 'Atlas slipped.')

  assert.deepEqual(await ok(vault, 'notes', 'aliases', target.id, '--add', 'Atlas'), {
    aliases: ['Atlas']
  })
  assert.deepEqual(await ok(vault, 'notes', 'aliases', target.id), { aliases: ['Atlas'] })
  assert.equal((await ok<{ id: string }>(vault, 'notes', 'resolve', 'atlas')).id, target.id)
  assert.deepEqual(await ok(vault, 'notes', 'resolve', 'Atlas', 'Missing'), {
    Atlas: { id: target.id, path: target.path },
    Missing: null
  })

  const mentions = await ok<Array<{ sourceId: string }>>(
    vault,
    'notes',
    'unlinked-mentions',
    target.id
  )
  assert.deepEqual(
    mentions.map((mention) => mention.sourceId),
    [source.id]
  )
  assert.deepEqual(
    await ok(vault, 'notes', 'link-mention', source.id, target.id, '--ordinal', '0'),
    { linked: true }
  )
  assert.equal(
    (await ok<Note>(vault, 'notes', 'get', source.id)).content.trim(),
    '[[Project Atlas|Atlas]] slipped.'
  )
  assert.deepEqual(await ok(vault, 'notes', 'aliases', target.id, '--clear'), { aliases: [] })
})

test('notes similar and suggest-tags fail with a message that names the desktop', async () => {
  const vault = await makeVault()
  const note = await ok<Note>(vault, 'notes', 'create', 'Anything')
  for (const command of ['similar', 'suggest-tags']) {
    const result = await cli(vault, 'notes', command, note.id)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /desktop app/)
  }
})

test('apply-template, carried-tasks, positions, reorder and folder template through the CLI', async () => {
  const vault = await makeVault()
  const template = await ok<{ id: string }>(
    vault,
    'templates',
    'create',
    'Brief',
    '--content',
    '# {{title}}'
  )
  const note = await ok<Note>(vault, 'notes', 'create', 'Launch', '--folder', 'Docs')
  const other = await ok<Note>(vault, 'notes', 'create', 'Other', '--folder', 'Docs')

  const applied = await ok<Note>(
    vault,
    'notes',
    'apply-template',
    note.id,
    template.id,
    '--body-only'
  )
  assert.equal(applied.content.trim(), '# Launch')

  await ok(vault, 'notes', 'reorder', '--folder', 'Docs', other.path, note.path)
  assert.deepEqual(await ok(vault, 'notes', 'positions', '--folder', 'Docs'), {
    positions: { [other.path]: 0, [note.path]: 1 }
  })
  assert.deepEqual(await ok(vault, 'notes', 'carried-tasks', note.id), { taskIds: [] })

  assert.deepEqual(await ok(vault, 'folders', 'template', 'Docs'), {
    folder: 'Docs',
    template: null
  })
  assert.deepEqual(await ok(vault, 'folders', 'template', 'Docs', template.id), {
    folder: 'Docs',
    template: template.id
  })
  assert.deepEqual(await ok(vault, 'folders', 'template', 'Docs'), {
    folder: 'Docs',
    template: template.id
  })
  assert.deepEqual(await ok(vault, 'folders', 'template', 'Docs', '--clear'), {
    folder: 'Docs',
    template: null
  })
})

test('read-lines and grep through the CLI', async () => {
  const vault = await makeVault()
  await fs.writeFile(path.join(vault, 'run.log'), 'alpha\nbeta\nGamma beta\n')
  assert.deepEqual(
    await ok(vault, 'notes', 'read-lines', 'run.log', '--from', '1', '--count', '2'),
    {
      startLine: 1,
      lines: ['beta', 'Gamma beta'],
      truncated: [],
      endOfFile: true
    }
  )
  assert.deepEqual(await ok(vault, 'notes', 'grep', 'run.log', 'BETA'), {
    status: 'complete',
    query: 'BETA',
    hits: [
      { line: 1, ordinal: 0 },
      { line: 2, ordinal: 0 }
    ],
    total: 2,
    limited: false
  })
  const bad = await cli(vault, 'notes', 'read-lines', 'run.log', '--count', '0')
  assert.equal(bad.code, 1)
})

test('attachment-rename, attachments --all and attach --existing through the CLI', async () => {
  const vault = await makeVault()
  const owner = await ok<Note>(vault, 'notes', 'create', 'Owner')
  const borrower = await ok<Note>(vault, 'notes', 'create', 'Borrower')
  const file = path.join(vault, 'scan.pdf')
  await fs.writeFile(file, 'pdf')
  const added = await ok<{ filename: string }>(vault, 'notes', 'attach', owner.id, file)

  const renamed = await ok<{ storedFilename: string; name: string }>(
    vault,
    'notes',
    'attachment-rename',
    owner.id,
    added.filename,
    'Invoice',
    'March'
  )
  assert.match(renamed.storedFilename, /-Invoice-March\.pdf$/)
  assert.equal(renamed.name, 'Invoice March.pdf')

  const all = await ok<Array<{ ownerNoteId: string; filename: string }>>(
    vault,
    'notes',
    'attachments',
    '--all'
  )
  assert.deepEqual(
    all.map((entry) => [entry.ownerNoteId, entry.filename]),
    [[owner.id, renamed.storedFilename]]
  )
  // `attachments <note>` keeps its per-note shape.
  assert.equal((await ok<unknown[]>(vault, 'notes', 'attachments', owner.id)).length, 1)

  const shared = await ok<{ success: boolean }>(
    vault,
    'notes',
    'attach',
    borrower.id,
    '--existing',
    `${owner.id}/${renamed.storedFilename}`
  )
  assert.equal(shared.success, true)
  assert.ok(
    (await ok<Note>(vault, 'notes', 'get', borrower.id)).content.includes(renamed.storedFilename)
  )
  assert.equal((await cli(vault, 'notes', 'attach', borrower.id, '--existing', 'nope')).code, 1)
  assert.equal(
    (await cli(vault, 'notes', 'attach', borrower.id, '--existing', 'a/b', '--url', 'http://x'))
      .code,
    1
  )
})

test('properties option, merge, resolve-refs and calendar commands through the CLI', async () => {
  const vault = await makeVault()
  const note = await ok<Note>(vault, 'notes', 'create', 'Props', '--properties', '{"a":1,"b":2}')

  await ok(vault, 'properties', 'option-add', 'mood', 'Calm', '--color', 'sky')
  await ok(vault, 'properties', 'option-add', 'mood', 'Tense')
  await ok(vault, 'properties', 'option-rename', 'mood', 'Tense', 'Wired')
  await ok(vault, 'properties', 'option-color', 'mood', 'Wired', 'rose')
  const guarded = await cli(vault, 'properties', 'option-remove', 'mood', 'Calm')
  assert.equal(guarded.code, 1)
  assert.match(guarded.stderr, /--yes/)
  await ok(vault, 'properties', 'option-remove', 'mood', 'Calm', '--yes')
  const definitions = await ok<Array<{ name: string; options: string }>>(
    vault,
    'properties',
    'definitions'
  )
  assert.deepEqual(JSON.parse(definitions.find((d) => d.name === 'mood')?.options ?? '[]'), [
    { value: 'Wired', color: 'rose' }
  ])

  assert.deepEqual(await ok(vault, 'properties', 'merge', note.id, '{"a":null,"c":3}'), {
    properties: { b: 2, c: 3 },
    removed: ['a']
  })
  assert.equal((await cli(vault, 'properties', 'merge', note.id, '[1]')).code, 1)

  const refs = await ok<Array<{ exists: boolean; title: string }>>(
    vault,
    'properties',
    'resolve-refs',
    `memry://note/${note.id}`,
    'memry://note/missing'
  )
  assert.deepEqual(
    refs.map((ref) => [ref.exists, ref.title]),
    [
      [true, 'Props'],
      [false, '']
    ]
  )

  assert.deepEqual(await ok(vault, 'properties', 'calendar-names'), [])
  await ok(vault, 'properties', 'calendar-visibility', 'due', 'true')
  assert.deepEqual(await ok(vault, 'properties', 'calendar-names'), ['due'])
  assert.equal((await cli(vault, 'properties', 'calendar-visibility', 'due', 'maybe')).code, 1)
  await ok(vault, 'properties', 'ensure', 'rating', 'number')
})

// D4: the CLI treats a note body as text it must not reshape. These are the
// constructs desktop gave new on-disk syntax to; each must survive every CLI
// write path byte for byte.
const FORMAT_BODY = [
  '> [!info]-',
  '> Starts closed',
  '',
  '> [!tip]+ Open title',
  '> Starts open',
  '',
  '> [!danger]',
  '> A custom or foreign callout type stays as written',
  '',
  '> [!my-custom-type]- Team callout',
  '> Custom type with a fold marker',
  '',
  '<!-- file:{"url":"../attachments/n1/abc123-spec.pdf","name":"spec.pdf","size":9,"mimeType":"application/pdf","display":"link"} -->',
  '',
  '<!-- link-card:{"size":"medium","cover":true,"preview":true} -->',
  '[[Target Note]]',
  '',
  '<!-- link-card:{"size":"small"} -->',
  '[[Target Note|a label]]'
].join('\n')

test('callout fold markers, custom callouts, PDF display and link cards survive CLI writes', async () => {
  const vault = await makeVault()
  const target = await ok<Note>(vault, 'notes', 'create', 'Target Note', '--content', 'target')
  const note = await ok<Note>(vault, 'notes', 'create', 'Formats', '--content', FORMAT_BODY)
  assert.equal(note.content.trimEnd(), FORMAT_BODY)

  // update --append leaves the existing block syntax alone.
  const appended = await ok<Note>(vault, 'notes', 'update', note.id, '--append', 'Tail line')
  assert.equal(appended.content.trimEnd(), `${FORMAT_BODY}\n\nTail line`)

  // A tag-only update rewrites frontmatter but not the body.
  const tagged = await ok<Note>(vault, 'notes', 'update', note.id, '--tag', 'x')
  assert.equal(tagged.content.trimEnd(), `${FORMAT_BODY}\n\nTail line`)

  // Renaming the linked note repoints the link text without touching the
  // sidecar marker lines.
  await ok(vault, 'notes', 'rename', target.id, 'Renamed Target')
  const after = await ok<Note>(vault, 'notes', 'get', note.id)
  assert.equal(
    after.content.trimEnd(),
    `${FORMAT_BODY.replaceAll('[[Target Note', '[[Renamed Target')}\n\nTail line`
  )

  // The link graph still sees a sole-link paragraph behind a marker.
  const links = await ok<{ outgoing: Array<{ title: string; noteId: string | null }> }>(
    vault,
    'notes',
    'links',
    note.id
  )
  assert.ok(links.outgoing.every((link) => link.noteId === target.id))

  // export-markdown copies the body verbatim.
  const exported = path.join(vault, 'out.md')
  await ok(vault, 'notes', 'export-markdown', note.id, exported)
  const exportedBody = await fs.readFile(exported, 'utf8')
  assert.ok(exportedBody.includes('> [!info]-\n> Starts closed'))
  assert.ok(exportedBody.includes('> [!tip]+ Open title'))
  assert.ok(exportedBody.includes('> [!my-custom-type]- Team callout'))
  assert.ok(exportedBody.includes('"display":"link"'))
  assert.ok(
    exportedBody.includes('<!-- link-card:{"size":"medium","cover":true,"preview":true} -->')
  )

  // export-html succeeds and keeps the callout text and link label.
  const htmlPath = path.join(vault, 'out.html')
  await ok(vault, 'notes', 'export-html', note.id, htmlPath)
  const html = await fs.readFile(htmlPath, 'utf8')
  assert.ok(html.includes('Starts closed'))
  assert.ok(html.includes('Team callout'))
  assert.ok(html.includes('a label'))
})
