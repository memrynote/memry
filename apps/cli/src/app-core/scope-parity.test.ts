import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { eq } from 'drizzle-orm'
import { attachmentUploadQueue, noteMetadata, templates } from '@memry/db-schema/data-schema'

import { openDatabases } from './database.ts'
import { createMemryApp } from './memry-app.ts'
import { safeFilename } from './paths.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-scope')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

test('renaming a note rewrites inbound wiki-links vault-wide, self-links and journals included', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    const old = await app.notes.create({
      title: 'Old Title',
      content: 'I link to myself: [[Old Title]]'
    })
    const referrer = await app.notes.create({
      title: 'Referrer',
      content:
        'Plain [[Old Title]], heading [[Old Title#Decisions]], alias [[Old Title|the plan]], other [[Bystander]].'
    })
    const bystander = await app.notes.create({
      title: 'Bystander',
      content: 'No links to the renamed note.'
    })
    await app.journal.write('2026-08-24', 'Journal ref: [[Old Title]]')

    const renamed = await app.notes.rename(old.id, 'New Title')
    assert.equal(renamed.title, 'New Title')
    // The renamed note's own body was a source too.
    assert.equal(renamed.content.trim(), 'I link to myself: [[New Title]]')

    const referrerAfter = await app.notes.get(referrer.id)
    assert.equal(
      referrerAfter?.content.trim(),
      'Plain [[New Title]], heading [[New Title#Decisions]], alias [[New Title|the plan]], other [[Bystander]].'
    )

    const bystanderAfter = await app.notes.get(bystander.id)
    assert.equal(bystanderAfter?.content.trim(), 'No links to the renamed note.')

    const journalAfter = await app.journal.get('2026-08-24')
    assert.equal(journalAfter?.content.trim(), 'Journal ref: [[New Title]]')

    // Backlinks resolve against the new title, so the graph survives the rename.
    const links = await app.notes.getLinks(renamed.id)
    assert.ok(links.backlinks.some((backlink) => backlink.id === referrer.id))
  } finally {
    app.close()
  }
})

test('safeFilename matches desktop sanitizeFilename: Obsidian-forbidden chars, leading dots, cap', () => {
  assert.equal(safeFilename('My [Draft] #1 ^note'), 'My Draft 1 note')
  assert.equal(safeFilename('a<b>c:d"e/f\\g|h?i*j'), 'abcdefghij')
  assert.equal(safeFilename('.hidden'), 'hidden')
  assert.equal(safeFilename('..'), 'untitled')
  assert.equal(safeFilename('   '), 'untitled')
  assert.equal(safeFilename('x'.repeat(250)).length, 200)
})

test('folder paths are vault-relative; defaultNoteFolder is only the unplaced-note destination', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.vault.updateConfig({ defaultNoteFolder: 'notes' })

    const unplaced = await app.notes.create({ title: 'Homed', content: '' })
    assert.equal(unplaced.path, 'notes/Homed.md')

    const placed = await app.notes.create({ title: 'Placed', content: '', folder: 'Projects' })
    assert.equal(placed.path, 'Projects/Placed.md')

    const listed = await app.notes.list({ folder: 'Projects' })
    assert.deepEqual(
      listed.map((note) => note.id),
      [placed.id]
    )

    // A rename stays in the note's current folder.
    const renamed = await app.notes.rename(placed.id, 'Placed Again')
    assert.equal(renamed.path, 'Projects/Placed Again.md')

    // Moving to '' means the vault root, not defaultNoteFolder.
    const moved = await app.notes.move(placed.id, '')
    assert.equal(moved.path, 'Placed Again.md')

    const folders = await app.folders.list()
    assert.ok(folders.some((folder) => folder.path === 'Projects'))
  } finally {
    app.close()
  }
})

test('.folder.md round-trips the icon through folder-view writes', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.folders.create('Projects')
    await fs.writeFile(
      path.join(vaultPath, 'Projects', '.folder.md'),
      '---\nicon: custom:icon_abc123\n---\n',
      'utf-8'
    )

    await app.folderView.setView('Projects', { name: 'Board', type: 'kanban', default: true })

    const raw = await fs.readFile(path.join(vaultPath, 'Projects', '.folder.md'), 'utf-8')
    assert.match(raw, /icon: '?custom:icon_abc123'?/)
    assert.match(raw, /Board/)

    const { config } = await app.folderView.getConfig('Projects')
    assert.equal(config.icon, 'custom:icon_abc123')
  } finally {
    app.close()
  }
})

test('.memry/properties.md carries date and project definitions and never a relation', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.properties.createDefinition({
      name: 'due',
      type: 'date',
      options: JSON.stringify({ showOnCalendar: true })
    })
    await app.properties.createDefinition({ name: 'client', type: 'project' })
    await app.properties.createDefinition({ name: 'linked', type: 'relation' })
    await app.properties.createDefinition({
      name: 'stage',
      type: 'select',
      options: JSON.stringify(['Draft', 'Final'])
    })

    const raw = await fs.readFile(path.join(vaultPath, '.memry', 'properties.md'), 'utf-8')
    assert.match(raw, /due:/)
    assert.match(raw, /type: date/)
    assert.match(raw, /showOnCalendar: true/)
    assert.match(raw, /client:/)
    assert.match(raw, /type: project/)
    assert.match(raw, /stage:/)
    // A relation entry would fail desktop's file schema and discard everything.
    assert.doesNotMatch(raw, /linked:/)
    assert.doesNotMatch(raw, /relation/)
  } finally {
    app.close()
  }
})

test('templates live in data.db: legacy files import once, deletes stick, no new files are written', async () => {
  const vaultPath = await makeVault()

  const legacyDir = path.join(vaultPath, '.memry', 'templates')
  await fs.mkdir(legacyDir, { recursive: true })
  await fs.writeFile(
    path.join(legacyDir, 'template_legacy1.md'),
    '---\nid: template_legacy1\nname: Legacy One\n---\nLegacy body',
    'utf-8'
  )

  const app = await createMemryApp({ vaultPath })
  let createdId: string
  try {
    const listed = await app.templates.list()
    assert.ok(listed.some((template) => template.id === 'template_legacy1'))

    const created = await app.templates.create({ name: 'Fresh', content: 'Fresh body' })
    createdId = created.id
    const files = await fs.readdir(legacyDir)
    assert.ok(!files.some((file) => file.includes(createdId)))

    const databases = openDatabases(vaultPath)
    try {
      const row = databases.dataDb.select().from(templates).where(eq(templates.id, createdId)).get()
      assert.equal(row?.name, 'Fresh')
    } finally {
      databases.close()
    }

    assert.equal(await app.templates.delete('template_legacy1'), true)
  } finally {
    app.close()
  }

  // The one-shot flag is burned: a deleted legacy template must not resurrect.
  const reopened = await createMemryApp({ vaultPath })
  try {
    const listed = await reopened.templates.list()
    assert.ok(!listed.some((template) => template.id === 'template_legacy1'))
    assert.ok(listed.some((template) => template.id === createdId))
  } finally {
    reopened.close()
  }
})

test('opening a vault preserves the preferences block desktop keeps in config.json', async () => {
  const vaultPath = await makeVault()
  const memryDir = path.join(vaultPath, '.memry')
  await fs.mkdir(memryDir, { recursive: true })
  await fs.writeFile(
    path.join(memryDir, 'config.json'),
    `${JSON.stringify({ journalFolder: 'journal', preferences: { theme: 'dark', language: 'tr' } }, null, 2)}\n`,
    'utf-8'
  )

  const app = await createMemryApp({ vaultPath })
  try {
    const raw = JSON.parse(await fs.readFile(path.join(memryDir, 'config.json'), 'utf-8')) as {
      preferences?: Record<string, unknown>
    }
    assert.deepEqual(raw.preferences, { theme: 'dark', language: 'tr' })
  } finally {
    app.close()
  }
})

test('notes attach embeds the file desktop-style and queues the upload for sync', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    await app.vault.updateConfig({ defaultNoteFolder: 'notes' })
    const note = await app.notes.create({ title: 'Attach Target', content: 'Existing body' })

    // Image: markdown-breaking chars leave the filename itself (desktop
    // generateUniqueFilename parity), and the embed is note-relative (#1606).
    const imageSource = path.join(vaultPath, 'screen shot (final).png')
    await fs.writeFile(imageSource, 'png bytes', 'utf-8')
    const image = await app.attachments.add(note.id, imageSource)
    assert.equal(image.success, true)
    assert.match(image.filename ?? '', /^file_.{12}-screen-shot-final\.png$/)
    assert.equal(image.ref, `../attachments/${note.id}/${image.filename}`)

    // Non-image: the renderer's clickable file-block marker, not a bare link.
    const pdfSource = path.join(vaultPath, 'report.pdf')
    await fs.writeFile(pdfSource, 'pdf bytes', 'utf-8')
    const pdf = await app.attachments.add(note.id, pdfSource)
    assert.equal(pdf.success, true)

    const after = await app.notes.get(note.id)
    assert.ok(after?.content.startsWith('Existing body'))
    assert.ok(after?.content.includes(`![screen shot (final).png](${image.ref})`))
    assert.ok(
      after?.content.includes(
        `<!-- file:${JSON.stringify({ url: pdf.ref, name: 'report.pdf', size: 9, mimeType: 'application/pdf' })} -->`
      )
    )

    const databases = openDatabases(vaultPath)
    try {
      // Upload intent lands in the shared outbox; desktop's sync runtime drains
      // it, uploads the bytes, and only then records the server-minted id.
      const queued = databases.dataDb
        .select()
        .from(attachmentUploadQueue)
        .where(eq(attachmentUploadQueue.noteId, note.id))
        .all()
      // Both sides sorted: the paths embed random attachment ids, so the
      // insertion order is not a stable expectation.
      assert.deepEqual(
        queued.map((row) => row.diskPath).sort(),
        [image.absolutePath, pdf.absolutePath].sort()
      )
      // Attachment ids are minted by the upload path — the CLI must never
      // invent one, or peers request a blob the server does not have.
      const metadata = databases.dataDb
        .select()
        .from(noteMetadata)
        .where(eq(noteMetadata.id, note.id))
        .get()
      assert.ok(!metadata?.attachmentReferences?.length)
    } finally {
      databases.close()
    }
  } finally {
    app.close()
  }
})

test('attaching to a local-only note embeds but never queues an upload', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    const note = await app.notes.create({ title: 'Private', content: '' })
    await app.notes.setLocalOnly(note.id, true)

    const source = path.join(vaultPath, 'secret.png')
    await fs.writeFile(source, 'png bytes', 'utf-8')
    const attachment = await app.attachments.add(note.id, source)
    assert.equal(attachment.success, true)

    const after = await app.notes.get(note.id)
    assert.ok(after?.content.includes(`![secret.png](${attachment.ref})`))

    const databases = openDatabases(vaultPath)
    try {
      const queued = databases.dataDb
        .select()
        .from(attachmentUploadQueue)
        .where(eq(attachmentUploadQueue.noteId, note.id))
        .all()
      assert.equal(queued.length, 0)
    } finally {
      databases.close()
    }
  } finally {
    app.close()
  }
})

test('frontmatter tags dedupe case-insensitively with the first casing winning', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })
  try {
    const note = await app.notes.create({
      title: 'Tagged',
      content: '',
      tags: ['Work', 'work', 'WORK', 'Deep Work']
    })
    assert.deepEqual(note.tags, ['Work', 'Deep Work'])
  } finally {
    app.close()
  }
})
