import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { runCli } from '../run.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-import')
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

interface Summary {
  importer: string
  imported: number
  attachments: number
  skipped: number
  failed: Array<{ item: string; error: string }>
  warnings: string[]
  notes: Array<{ id: string; title: string; path: string }>
}

interface Preview {
  groups: Array<{
    label: string
    counts: Array<{ value: number }>
    sampleTitles?: string[]
    error?: { message: string }
    warnings?: string[]
  }>
}

async function makeMarkdownSource(vaultPath: string) {
  const source = path.join(vaultPath, '..', `source-${randomUUID()}`)
  await fs.mkdir(path.join(source, 'sub'), { recursive: true })
  await fs.writeFile(
    path.join(source, 'Top.md'),
    '---\ntitle: Frontmatter Title\ntags: [alpha, beta]\nstatus: draft\n---\nBody with ![pic](img/a.png)\n'
  )
  await fs.writeFile(path.join(source, 'sub', 'Nested.md'), '- [ ] ship it\n')
  await fs.writeFile(path.join(source, 'readme.txt'), 'ignored')
  return source
}

test('import sources lists the desktop catalog and marks what runs from the CLI', async () => {
  const vaultPath = await makeVault()
  const sources = await runOk<Array<{ id: string; name: string; cli: boolean; reason?: string }>>(
    vaultPath,
    ['import', 'sources']
  )

  assert.deepEqual(
    sources
      .filter((source) => source.cli)
      .map((source) => source.id)
      .sort(),
    ['csv', 'markdown', 'roam']
  )
  // Every desktop built-in is named, so a user can tell "not here" from "does not exist".
  for (const id of [
    'apple-notes',
    'bear',
    'evernote',
    'notion',
    'onenote',
    'readwise',
    'todoist'
  ]) {
    const source = sources.find((entry) => entry.id === id)
    assert.ok(source, id)
    assert.equal(source.cli, false)
    assert.match(source.reason ?? '', /desktop app/)
  }
  assert.deepEqual(
    sources.map((source) => source.name),
    sources.map((source) => source.name).sort((a, b) => a.localeCompare(b))
  )
})

test('import preview plans markdown notes without writing anything', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  const source = await makeMarkdownSource(vaultPath)

  const preview = await runOk<Preview>(vaultPath, ['import', 'preview', 'markdown', source])
  assert.equal(preview.groups.length, 1)
  assert.equal(preview.groups[0].counts[0].value, 2)
  assert.deepEqual([...(preview.groups[0].sampleTitles ?? [])].sort(), [
    'Frontmatter Title',
    'Nested'
  ])
  assert.match(preview.groups[0].warnings?.[0] ?? '', /1 image\/file reference/)
  assert.deepEqual(await runOk(vaultPath, ['notes', 'list']), [])
})

test('import start markdown creates notes with frontmatter title, tags, properties and folders', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  const source = await makeMarkdownSource(vaultPath)

  const summary = await runOk<Summary>(vaultPath, ['import', 'start', 'markdown', source])
  assert.equal(summary.imported, 2)
  assert.equal(summary.attachments, 0)
  assert.deepEqual(summary.failed, [])
  assert.ok(summary.warnings.some((warning) => /checklists/.test(warning)))

  const top = await runOk<{
    title: string
    tags: string[]
    path: string
    properties: Record<string, unknown>
  }>(vaultPath, [
    'notes',
    'get',
    summary.notes.find((note) => note.title === 'Frontmatter Title')!.id
  ])
  assert.deepEqual([...top.tags].sort(), ['alpha', 'beta'])
  assert.equal(top.properties.status, 'draft')
  assert.match(top.path, /^Markdown\/Frontmatter Title\.md$/)
  const nested = summary.notes.find((note) => note.title === 'Nested')!
  assert.match(nested.path, /^Markdown\/sub\/Nested\.md$/)
})

test('import start --folder replaces the importer root and keeps the subfolders', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  const source = await makeMarkdownSource(vaultPath)

  const summary = await runOk<Summary>(vaultPath, [
    'import',
    'start',
    'markdown',
    source,
    '--folder',
    'Archive/Old'
  ])
  assert.deepEqual(summary.notes.map((note) => note.path).sort(), [
    'Archive/Old/Frontmatter Title.md',
    'Archive/Old/sub/Nested.md'
  ])
  assert.match(
    (await run(vaultPath, ['import', 'start', 'markdown', source, '--folder', '../x'])).stderr,
    /Invalid import folder/
  )
})

test('import start csv and roam map rows and pages through the shared importers', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  const csvPath = path.join(vaultPath, '..', `rows-${randomUUID()}.csv`)
  await fs.writeFile(csvPath, 'Title,Owner\nFirst row,ann\nSecond row,bob\n,nobody\n')
  const roamPath = path.join(vaultPath, '..', `roam-${randomUUID()}.json`)
  await fs.writeFile(
    roamPath,
    JSON.stringify([{ title: 'Page One', children: [{ string: 'hello', uid: 'u1' }] }])
  )

  const csv = await runOk<Summary>(vaultPath, ['import', 'start', 'csv', csvPath])
  assert.equal(csv.imported, 2)
  assert.equal(csv.skipped, 1)
  assert.ok(csv.notes.every((note) => note.path.startsWith('CSV/')))

  const roam = await runOk<Summary>(vaultPath, ['import', 'start', 'roam', roamPath])
  assert.equal(roam.imported, 1)
  assert.equal(roam.notes[0].title, 'Page One')
  assert.match(roam.notes[0].path, /^Roam\//)
})

test('import reports a bad source file per item and exits cleanly for the rest', async () => {
  const vaultPath = await makeVault()
  await runOk(vaultPath, ['vault', 'init'])
  const bad = path.join(vaultPath, '..', `bad-${randomUUID()}.json`)
  await fs.writeFile(bad, '{"not":"an array"}')
  const summary = await runOk<Summary>(vaultPath, ['import', 'start', 'roam', bad])
  assert.equal(summary.imported, 0)
  assert.equal(summary.failed.length, 1)
  assert.match(summary.failed[0].error, /Not a Roam JSON export/)

  const preview = await runOk<Preview>(vaultPath, ['import', 'preview', 'roam', bad])
  assert.match(preview.groups[0].error?.message ?? '', /Not a Roam JSON export/)
})

test('import refuses desktop-only and unknown sources with a pointer', async () => {
  const vaultPath = await makeVault()
  const notes = await run(vaultPath, ['import', 'start', 'apple-notes', '/tmp/x'])
  assert.equal(notes.code, 1)
  assert.match(notes.stderr, /Apple Notes importer is not available from the CLI/)
  assert.match(notes.stderr, /password/)

  const unknown = await run(vaultPath, ['import', 'start', 'nope', '/tmp/x'])
  assert.equal(unknown.code, 1)
  assert.match(unknown.stderr, /import sources/)

  const noPath = await run(vaultPath, ['import', 'start', 'markdown'])
  assert.equal(noPath.code, 1)
  assert.match(noPath.stderr, /Missing source path/)
})

test('the CLI catalog names every importer the desktop app registers', async () => {
  const importDir = path.join(process.cwd(), '..', 'desktop', 'src', 'main', 'import')
  const desktop: Array<{ id: string; name: string }> = []
  for (const entry of await fs.readdir(importDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of await fs.readdir(path.join(importDir, entry.name))) {
      if (!file.endsWith('-importer.ts')) continue
      const source = await fs.readFile(path.join(importDir, entry.name, file), 'utf8')
      const id = /^ {2}id: '([^']+)'/m.exec(source)?.[1]
      const name = /^ {2}name: '([^']+)'/m.exec(source)?.[1]
      if (id && name) desktop.push({ id, name })
    }
  }
  assert.ok(desktop.length >= 15, 'found the desktop importers')

  const vaultPath = await makeVault()
  const catalog = await runOk<Array<{ id: string; name: string }>>(vaultPath, ['import', 'sources'])
  assert.deepEqual(
    catalog.map(({ id, name }) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id)),
    desktop.sort((a, b) => a.id.localeCompare(b.id))
  )
})
