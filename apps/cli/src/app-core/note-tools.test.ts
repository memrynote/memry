import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import matter from 'gray-matter'

import { createMemryApp, type MemryApp } from './memry-app.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-note-tools')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

async function withApp(run: (app: MemryApp, vaultPath: string) => Promise<void>) {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await run(app, vaultPath)
  } finally {
    app.close()
  }
}

test('aliases are edited as a delta in frontmatter and `resolve` honors them', async () => {
  await withApp(async (app, vaultPath) => {
    const note = await app.notes.create({ title: 'Meeting Notes', content: 'Body', tags: ['work'] })
    assert.deepEqual(await app.noteTools.aliases(note.id), { aliases: [] })

    const added = await app.noteTools.aliases(note.id, {
      add: ['Standup', ' Sync  ', 'standup', 'Meeting Notes']
    })
    // Deduped by name key, trimmed, and never equal to the title.
    assert.deepEqual(added, { aliases: ['Standup', 'Sync'] })
    const raw = matter(await fs.readFile(path.join(vaultPath, note.path), 'utf8'))
    assert.deepEqual(raw.data.aliases, ['Standup', 'Sync'])
    assert.deepEqual(raw.data.tags, ['work'])
    assert.equal(raw.content.trim(), 'Body')

    // A title always beats an alias; an alias alone still resolves.
    assert.equal((await app.notes.resolveWikiTarget('standup'))?.id, note.id)
    assert.equal((await app.notes.resolveByTitle('Sync'))?.id, note.id)
    await app.notes.create({ title: 'Sync', content: 'a real note' })
    assert.notEqual((await app.notes.resolveByTitle('Sync'))?.id, note.id)

    const removed = await app.noteTools.aliases(note.id, { remove: ['STANDUP'] })
    assert.deepEqual(removed, { aliases: ['Sync'] })
    assert.equal(await app.notes.resolveByTitle('standup'), null)

    assert.deepEqual(await app.noteTools.aliases(note.id, { set: ['One', 'Two'] }), {
      aliases: ['One', 'Two']
    })
    assert.deepEqual(await app.noteTools.aliases(note.id, { set: [] }), { aliases: [] })
    assert.equal(
      'aliases' in matter(await fs.readFile(path.join(vaultPath, note.path), 'utf8')).data,
      false
    )
    await assert.rejects(app.noteTools.aliases('missing'), /Note not found/)
  })
})

test('resolveTitles answers an object keyed by title, aliases and paths included', async () => {
  await withApp(async (app) => {
    const note = await app.notes.create({ title: 'Plan', folder: 'Projects' })
    await app.noteTools.aliases(note.id, { add: ['Roadmap'] })
    const resolved = await app.noteTools.resolveTitles(['Plan', 'Roadmap', 'Projects/Plan', 'Nope'])
    assert.deepEqual(resolved.Plan, { id: note.id, path: note.path })
    assert.deepEqual(resolved.Roadmap, { id: note.id, path: note.path })
    assert.deepEqual(resolved['Projects/Plan'], { id: note.id, path: note.path })
    assert.equal(resolved.Nope, null)
  })
})

test('apply-template replaces the body, adds tags and keeps the note properties', async () => {
  await withApp(async (app) => {
    const template = await app.templates.create({
      name: 'Brief',
      content: '# {{title}}\n\n- [ ] Decide',
      tags: ['Planning', 'work'],
      properties: [
        { name: 'status', type: 'text', value: 'draft' },
        { name: 'owner', type: 'text', value: 'nobody' }
      ]
    })
    const note = await app.notes.create({
      title: 'Launch',
      content: 'old body',
      tags: ['WORK'],
      properties: { owner: 'Kaan' }
    })

    const full = await app.noteTools.applyTemplate(note.id, template.id)
    assert.equal(full.content.trim(), '# Launch\n\n- [ ] Decide')
    assert.deepEqual(full.tags, ['WORK', 'Planning'])
    assert.deepEqual(full.properties, { status: 'draft', owner: 'Kaan' })

    const other = await app.notes.create({ title: 'Other', content: 'x', tags: ['keep'] })
    const bodyOnly = await app.noteTools.applyTemplate(other.id, template.id, 'body')
    assert.equal(bodyOnly.content.trim(), '# Other\n\n- [ ] Decide')
    assert.deepEqual(bodyOnly.tags, ['keep'])
    assert.deepEqual(bodyOnly.properties, {})

    await assert.rejects(app.noteTools.applyTemplate(note.id, 'blank'), /Template not found/)
  })
})

test('unlinked mentions list plain-text names, skip linked sources, and link-mention rewrites one', async () => {
  await withApp(async (app) => {
    const target = await app.notes.create({ title: 'Project Atlas' })
    await app.noteTools.aliases(target.id, { add: ['Atlas'] })
    const mentioning = await app.notes.create({
      title: 'Standup',
      content: 'We talked about project atlas today. Atlas is late. Atlas again.'
    })
    await app.notes.create({
      title: 'Linked',
      content: 'Already [[Project Atlas]] and also Project Atlas in text.'
    })
    await app.notes.create({ title: 'Unrelated', content: 'Nothing here.' })

    const mentions = await app.noteTools.unlinkedMentions(target.id)
    assert.equal(mentions.length, 1)
    assert.equal(mentions[0].sourceId, mentioning.id)
    assert.equal(mentions[0].contexts.length, 3)

    assert.deepEqual(
      await app.noteTools.linkMention({
        sourceId: mentioning.id,
        targetId: target.id,
        ordinal: 1
      }),
      { linked: true }
    )
    const after = await app.notes.get(mentioning.id)
    assert.equal(
      after?.content.trim(),
      'We talked about project atlas today. [[Project Atlas|Atlas]] is late. Atlas again.'
    )
    assert.deepEqual(
      await app.noteTools.linkMention({
        sourceId: mentioning.id,
        targetId: target.id,
        ordinal: 9
      }),
      { linked: false }
    )
  })
})

test('carried tasks are the task lines a note holds, minus tasks still homed elsewhere', async () => {
  await withApp(async (app) => {
    const own = await app.tasks.create({ title: 'Own task' })
    const shared = await app.tasks.create({ title: 'Shared task' })
    const keep = await app.notes.create({ title: 'Survivor' })
    await app.tasks.update(shared.id, { linkedNoteIds: [keep.id] })
    const carrier = await app.notes.create({
      title: 'Carrier',
      folder: 'Box',
      content: `- [ ] Own task {task:${own.id}}\n- [x] Shared task {task:${shared.id}}\n- [ ] Ghost {task:missing}`
    })

    assert.deepEqual(await app.noteTools.carriedTasks({ noteIds: [carrier.id], folderPaths: [] }), {
      taskIds: [own.id]
    })
    assert.deepEqual(await app.noteTools.carriedTasks({ noteIds: [], folderPaths: ['Box'] }), {
      taskIds: [own.id]
    })
    // Deleting the survivor too leaves the shared task with no home.
    const both = await app.noteTools.carriedTasks({
      noteIds: [carrier.id, keep.id],
      folderPaths: []
    })
    assert.deepEqual([...both.taskIds].toSorted(), [own.id, shared.id].toSorted())
  })
})

test('positions and reorder keep a manual sidebar order per folder', async () => {
  await withApp(async (app) => {
    const a = await app.notes.create({ title: 'A', folder: 'Docs' })
    const b = await app.notes.create({ title: 'B', folder: 'Docs' })
    const c = await app.notes.create({ title: 'C', folder: 'Docs' })
    const elsewhere = await app.notes.create({ title: 'Z', folder: 'Other' })

    assert.deepEqual(await app.noteTools.positions(), { positions: {} })
    await app.noteTools.reorder('Docs', [c.path, a.path, b.path])
    assert.deepEqual(await app.noteTools.positions('Docs'), {
      positions: { [c.path]: 0, [a.path]: 1, [b.path]: 2 }
    })
    await app.noteTools.reorder('Docs', [b.path, c.path, a.path])
    assert.deepEqual((await app.noteTools.positions('Docs')).positions[b.path], 0)
    assert.deepEqual(await app.noteTools.positions('Other'), { positions: {} })
    assert.equal(Object.keys((await app.noteTools.positions()).positions).length, 3)

    await assert.rejects(app.noteTools.reorder('Docs', [elsewhere.path]), /not in folder/)
    await assert.rejects(app.noteTools.reorder('Docs', ['Docs/Missing.md']), /Note not found/)
  })
})

test('folder templates inherit down the tree and inherit:false stops the climb', async () => {
  await withApp(async (app, vaultPath) => {
    const template = await app.templates.create({ name: 'Daily', content: 'x' })
    await app.folders.create('Work')
    await app.folders.create('Work/Deep')
    await app.folders.create('Work/Sealed')

    assert.deepEqual(await app.noteTools.getFolderTemplate('Work/Deep'), {
      folder: 'Work/Deep',
      template: null
    })
    await app.noteTools.setFolderTemplate('Work', template.id)
    assert.equal((await app.noteTools.getFolderTemplate('Work/Deep')).template, template.id)

    await fs.writeFile(path.join(vaultPath, 'Work/Sealed/.folder.md'), '---\ninherit: false\n---\n')
    assert.equal((await app.noteTools.getFolderTemplate('Work/Sealed')).template, null)

    // Setting a template keeps the folder's views and icon.
    await app.folderView.setConfig('Work', { icon: 'briefcase' })
    await app.noteTools.setFolderTemplate('Work', null)
    const config = matter(await fs.readFile(path.join(vaultPath, 'Work/.folder.md'), 'utf8')).data
    assert.equal(config.icon, 'briefcase')
    assert.equal('template' in config, false)
    assert.equal((await app.noteTools.getFolderTemplate('Work')).template, null)
    await assert.rejects(app.noteTools.setFolderTemplate('Work', 'nope'), /Template not found/)
  })
})

test('read-lines and grep stream a large file by 0-based line', async () => {
  await withApp(async (app, vaultPath) => {
    const lines = Array.from({ length: 50 }, (_, index) =>
      `row ${index} ${index % 10 === 0 ? 'NEEDLE needle' : ''}`.trim()
    )
    await fs.writeFile(path.join(vaultPath, 'big.log'), `${lines.join('\r\n')}\n`)

    const page = await app.noteTools.readLines('big.log', 10, 3)
    assert.deepEqual(page.lines, lines.slice(10, 13))
    assert.equal(page.startLine, 10)
    assert.equal(page.endOfFile, false)
    const tail = await app.noteTools.readLines('big.log', 48, 10)
    assert.deepEqual(tail.lines, lines.slice(48))
    assert.equal(tail.endOfFile, true)

    const found = await app.noteTools.grep('big.log', 'needle')
    assert.equal(found.total, 10)
    assert.equal(found.limited, false)
    assert.deepEqual(found.hits.slice(0, 3), [
      { line: 0, ordinal: 0 },
      { line: 0, ordinal: 1 },
      { line: 10, ordinal: 0 }
    ])

    await assert.rejects(app.noteTools.readLines('big.log', -1, 5), /--from/)
    await assert.rejects(app.noteTools.readLines('big.log', 0, 5000), /--count/)
    await assert.rejects(app.noteTools.grep('big.log', 'a\nb'), /span lines/)
    await assert.rejects(
      app.noteTools.readLines('../outside.txt', 0, 5),
      /inside the vault|not found/i
    )
    await assert.rejects(app.noteTools.readLines('missing.md', 0, 5), /Note not found/)
  })
})

test('attachment rename keeps the prefix and extension and repoints the note body', async () => {
  await withApp(async (app, vaultPath) => {
    const note = await app.notes.create({ title: 'Docs', content: 'Intro' })
    const source = path.join(vaultPath, 'spec sheet.pdf')
    await fs.writeFile(source, 'pdf-bytes')
    const added = await app.attachments.add(note.id, source)
    assert.ok(added.filename)

    const renamed = await app.attachmentTools.rename(note.id, added.filename, 'Final Spec.pdf')
    assert.match(renamed.storedFilename, /-Final-Spec\.pdf$/)
    assert.equal(renamed.name, 'Final Spec.pdf')
    assert.equal(renamed.storedFilename.split('-')[0], added.filename.split('-')[0])
    const dir = path.join(vaultPath, 'attachments', note.id)
    assert.deepEqual(await fs.readdir(dir), [renamed.storedFilename])
    const body = (await app.notes.get(note.id))?.content ?? ''
    assert.ok(body.includes(renamed.storedFilename))
    assert.ok(!body.includes(added.filename))
    assert.match(body, /"name":"Final Spec\.pdf"/)

    await assert.rejects(
      app.attachmentTools.rename(note.id, 'nope.pdf', 'x'),
      /Attachment not found/
    )
    await assert.rejects(app.attachmentTools.rename(note.id, '../x.pdf', 'x'), /Invalid|not found/)
    await assert.rejects(app.attachmentTools.rename(note.id, renamed.storedFilename, '  '), /empty/)
  })
})

test('vault-wide attachment list, --existing and --url', async () => {
  await withApp(async (app, vaultPath) => {
    const owner = await app.notes.create({ title: 'Owner' })
    const borrower = await app.notes.create({ title: 'Borrower', folder: 'Sub' })
    const source = path.join(vaultPath, 'photo.png')
    await fs.writeFile(source, 'png-bytes')
    const added = await app.attachments.add(owner.id, source)

    const all = await app.attachmentTools.listVault()
    assert.equal(all.length, 1)
    assert.equal(all[0].ownerNoteId, owner.id)
    assert.equal(all[0].ownerNoteTitle, 'Owner')
    assert.equal(all[0].displayName, 'photo.png')
    assert.equal(all[0].type, 'image')

    const shared = await app.attachmentTools.attachExisting(
      borrower.id,
      owner.id,
      added.filename as string
    )
    assert.equal(shared.ref, `../attachments/${owner.id}/${added.filename}`)
    assert.ok(((await app.notes.get(borrower.id))?.content ?? '').includes(shared.ref))
    // Nothing was copied.
    assert.equal((await fs.readdir(path.join(vaultPath, 'attachments', owner.id))).length, 1)
    assert.equal((await app.attachmentTools.listVault()).length, 1)
    await assert.rejects(
      app.attachmentTools.attachExisting(borrower.id, owner.id, 'missing.png'),
      /not found/
    )
    await assert.rejects(
      app.attachmentTools.attachExisting(borrower.id, '..', 'x.png'),
      /Invalid attachment reference/
    )

    const server = http.createServer((request, response) => {
      if (request.url === '/pic.png') {
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end(Buffer.from('remote-png'))
      } else {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html></html>')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      const fetched = await app.attachmentTools.attachUrl(
        borrower.id,
        `http://127.0.0.1:${port}/pic.png`
      )
      assert.equal(fetched.success, true)
      assert.equal(
        await fs.readFile(path.join(vaultPath, fetched.path as string), 'utf8'),
        'remote-png'
      )
      await assert.rejects(
        app.attachmentTools.attachUrl(borrower.id, `http://127.0.0.1:${port}/page`),
        /not an image/
      )
      await assert.rejects(app.attachmentTools.attachUrl(borrower.id, 'file:///etc/passwd'), /http/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test('property options are edited through the definition and land in properties.md', async () => {
  await withApp(async (app, vaultPath) => {
    const readEntries = async () =>
      matter(await fs.readFile(path.join(vaultPath, '.memry', 'properties.md'), 'utf8')).data
        .properties

    // A missing select definition is created by the first option, like desktop.
    await app.propertyTools.addOption('mood', { value: 'Calm', color: 'sky' })
    await app.propertyTools.addOption('mood', { value: 'Tense' })
    await app.propertyTools.addOption('mood', { value: 'Calm', color: 'red' })
    assert.deepEqual((await readEntries()).mood.options, [
      { value: 'Calm', color: 'sky' },
      { value: 'Tense', color: 'stone' }
    ])

    await app.propertyTools.renameOption('mood', 'Tense', 'Wired')
    await app.propertyTools.setOptionColor('mood', 'Wired', 'rose')
    await app.propertyTools.removeOption('mood', 'Calm')
    assert.deepEqual((await readEntries()).mood.options, [{ value: 'Wired', color: 'rose' }])

    await assert.rejects(app.propertyTools.removeOption('ghost', 'x'), /No property definition/)
    await app.properties.createDefinition({ name: 'title2', type: 'text' })
    await assert.rejects(app.propertyTools.addOption('title2', { value: 'x' }), /has no options/)

    // Status options live in categories.
    await app.propertyTools.ensureDefinition('stage', 'status')
    await app.propertyTools.addOption('stage', { value: 'Blocked', color: 'red' }, 'in_progress')
    const stage = (await readEntries()).stage
    assert.deepEqual(
      stage.categories.in_progress.options.map((option: { value: string }) => option.value),
      ['In Progress', 'Blocked']
    )
    await app.propertyTools.renameOption('stage', 'Blocked', 'Stuck')
    await app.propertyTools.removeOption('stage', 'Abandoned')
    const after = (await readEntries()).stage.categories
    assert.deepEqual(
      after.in_progress.options.map((option: { value: string }) => option.value),
      ['In Progress', 'Stuck']
    )
    assert.deepEqual(
      after.done.options.map((option: { value: string }) => option.value),
      ['Done']
    )
    await assert.rejects(
      app.propertyTools.addOption('stage', { value: 'x' }, 'nope'),
      /Unknown status category/
    )
    await assert.rejects(
      app.propertyTools.addOption('mood', { value: 'x' }, 'todo'),
      /not a status property/
    )
  })
})

test('properties merge patches keys and null removes one', async () => {
  await withApp(async (app) => {
    const note = await app.notes.create({
      title: 'Merge',
      properties: { rating: 3, owner: 'Kaan', stale: 'x' }
    })
    const result = await app.propertyTools.merge(note.id, { rating: 5, stale: null, extra: true })
    assert.deepEqual(result.properties, { rating: 5, owner: 'Kaan', extra: true })
    assert.deepEqual(result.removed, ['stale'])
    await assert.rejects(app.propertyTools.merge('missing', { a: 1 }), /Entity not found/)
  })
})

test('resolve-refs answers in input order and never throws on a bad target', async () => {
  await withApp(async (app) => {
    const note = await app.notes.create({ title: 'Target' })
    const task = await app.tasks.create({ title: 'A task' })
    await app.journal.write('2026-02-03', 'day')
    const uris = [
      `memry://note/${note.id}`,
      `memry://task/${task.id}`,
      'memry://journal/2026-02-03',
      'memry://note/missing',
      'not-a-uri'
    ]
    const resolved = await app.propertyTools.resolveRefs(uris)
    assert.deepEqual(
      resolved.map((ref) => [ref.uri, ref.exists, ref.title]),
      [
        [uris[0], true, 'Target'],
        [uris[1], true, 'A task'],
        [uris[2], true, '2026-02-03'],
        [uris[3], false, ''],
        [uris[4], false, '']
      ]
    )
    assert.equal(resolved[2].date, '2026-02-03')
  })
})

test('calendar property visibility flags date properties and a bare flag leaves no definition', async () => {
  await withApp(async (app, vaultPath) => {
    assert.deepEqual(await app.propertyTools.calendarNames(), [])
    await app.propertyTools.setCalendarVisibility('due', true)
    await app.propertyTools.setCalendarVisibility('start', true)
    assert.deepEqual(await app.propertyTools.calendarNames(), ['due', 'start'])
    const entries = matter(
      await fs.readFile(path.join(vaultPath, '.memry', 'properties.md'), 'utf8')
    ).data.properties
    assert.deepEqual(entries.due, { type: 'date', showOnCalendar: true })

    await app.propertyTools.setCalendarVisibility('due', false)
    assert.deepEqual(await app.propertyTools.calendarNames(), ['start'])
    assert.equal(
      (await app.properties.definitions()).some((definition) => definition.name === 'due'),
      false
    )

    // A date definition that carries a colour stays, flagged off.
    await app.properties.createDefinition({ name: 'kept', type: 'date', color: 'sky' })
    await app.propertyTools.setCalendarVisibility('kept', true)
    await app.propertyTools.setCalendarVisibility('kept', false)
    assert.deepEqual(await app.propertyTools.calendarNames(), ['start'])
    const kept = (await app.properties.definitions()).find(
      (definition) => definition.name === 'kept'
    )
    assert.equal(kept?.color, 'sky')

    // A flag set by desktop in properties.md is read and can be turned off.
    const file = path.join(vaultPath, '.memry', 'properties.md')
    const current = matter(await fs.readFile(file, 'utf8')).data.properties
    await fs.writeFile(
      file,
      matter.stringify('', {
        properties: { ...current, deskflag: { type: 'date', showOnCalendar: true } }
      })
    )
    assert.ok((await app.propertyTools.calendarNames()).includes('deskflag'))
    await app.propertyTools.setCalendarVisibility('deskflag', false)
    assert.ok(!(await app.propertyTools.calendarNames()).includes('deskflag'))
  })
})
