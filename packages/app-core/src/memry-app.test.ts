import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { calendarExternalEvents, calendarSources, syncState } from '@memry/db-schema/data-schema'

import { openDatabases } from './database.ts'
import { createMemryApp } from './memry-app.ts'

async function makeVault() {
  const root = path.join(process.cwd(), 'test-results', 'memry-cli-core')
  await fs.mkdir(root, { recursive: true })
  const vaultPath = path.join(root, `vault-${process.pid}-${randomUUID()}`)
  await fs.mkdir(vaultPath)
  return vaultPath
}

function seedExternalCalendarEvent(vaultPath: string): void {
  const databases = openDatabases(vaultPath)
  const now = '2026-05-13T00:00:00.000Z'
  try {
    databases.dataDb
      .insert(calendarSources)
      .values({
        id: 'calendar_source_google_work',
        provider: 'google',
        kind: 'calendar',
        accountId: 'kaan@example.com',
        remoteId: 'work-calendar',
        title: 'Work Calendar',
        timezone: 'UTC',
        color: '#0ea5e9',
        isSelected: true,
        createdAt: now,
        modifiedAt: now
      })
      .run()
    databases.dataDb
      .insert(calendarExternalEvents)
      .values({
        id: 'external_event_1',
        sourceId: 'calendar_source_google_work',
        remoteEventId: 'remote-event-1',
        remoteEtag: 'etag-1',
        title: 'Imported external event',
        description: 'From Google',
        location: 'Meet',
        startAt: '2026-05-15T09:00:00.000Z',
        endAt: '2026-05-15T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        attendees: [{ email: 'kaan@example.com', responseStatus: 'accepted' }],
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
        visibility: 'private',
        colorId: '7',
        conferenceData: { conferenceId: 'meet-1' },
        createdAt: now,
        modifiedAt: now
      })
      .run()
  } finally {
    databases.close()
  }
}

test('opens a standalone vault and exposes core note, journal, task, inbox, and folder operations', async () => {
  const vaultPath = await makeVault()
  const app = await createMemryApp({ vaultPath })

  assert.equal(app.vault.status().isOpen, true)
  assert.equal(app.vault.status().path, vaultPath)
  assert.deepEqual(
    (await app.vault.updateConfig({ excludePatterns: ['.git', 'tmp'] })).excludePatterns,
    ['.git', 'tmp']
  )
  assert.deepEqual(app.vault.config().excludePatterns, ['.git', 'tmp'])

  await app.folders.create('Projects')
  assert.deepEqual(
    (await app.folders.list()).map((folder) => folder.path),
    ['Projects']
  )
  await app.folderView.setView('Projects', {
    name: 'Table',
    type: 'table',
    default: true,
    columns: [{ id: 'title' }, { id: 'state' }, { id: 'priority' }]
  })

  const note = await app.notes.create({
    title: 'CLI Note',
    content: 'Body from the command line',
    folder: 'Projects',
    tags: ['cli'],
    properties: { status: 'draft' }
  })
  assert.equal(note.title, 'CLI Note')
  assert.equal(note.path, 'Projects/CLI Note.md')
  assert.deepEqual(note.properties, { status: 'draft' })

  const fetchedNote = await app.notes.get(note.id)
  assert.equal(fetchedNote?.content, 'Body from the command line\n')
  await app.properties.set(note.id, { status: 'active', priority: 3 })
  assert.deepEqual(await app.properties.get(note.id), {
    status: 'active',
    priority: 3
  })
  await app.properties.rename(note.id, 'status', 'state')
  assert.deepEqual(await app.properties.get(note.id), {
    state: 'active',
    priority: 3
  })
  const propertyDefinition = await app.properties.createDefinition({
    name: 'mood',
    type: 'select',
    options: JSON.stringify([{ value: 'Focused', color: 'emerald' }]),
    defaultValue: JSON.stringify('Focused')
  })
  assert.equal(propertyDefinition.name, 'mood')
  assert.equal(
    (await app.properties.definitions()).some((definition) => definition.name === 'mood'),
    true
  )
  assert.equal(
    (
      await app.properties.updateDefinition('mood', {
        options: JSON.stringify([{ value: 'Calm', color: 'sky' }])
      })
    )?.options,
    JSON.stringify([{ value: 'Calm', color: 'sky' }])
  )
  assert.equal(await app.properties.deleteDefinition('mood'), true)
  assert.equal(
    (await app.properties.definitions()).some((definition) => definition.name === 'mood'),
    false
  )
  const snapshot = await app.versions.create(note.id, 'manual', true)
  assert.equal(snapshot?.noteId, note.id)
  await app.notes.update({ id: note.id, content: 'Changed content' })
  assert.equal((await app.versions.history(note.id))[0]?.id, snapshot?.id)
  // Vault files carry no Memry title key; the snapshot stores the file verbatim
  assert.match(
    (await app.versions.get(snapshot?.id ?? ''))?.fileContent ?? '',
    /Body from the command line/
  )
  assert.equal(
    (await app.versions.restore(snapshot?.id ?? '')).content,
    'Body from the command line\n'
  )
  assert.equal(await app.versions.delete(snapshot?.id ?? ''), true)

  const attachmentSource = path.join(vaultPath, 'sample.txt')
  await fs.writeFile(attachmentSource, 'attachment body', 'utf-8')
  const attachment = await app.attachments.add(note.id, attachmentSource)
  assert.equal(attachment.success, true)
  assert.equal(attachment.name, 'sample.txt')
  assert.equal((await app.attachments.list(note.id))[0]?.filename, attachment.filename)
  assert.equal(await fs.readFile(attachment.absolutePath ?? '', 'utf-8'), 'attachment body')
  assert.equal(await app.attachments.delete(note.id, attachment.filename ?? ''), true)

  const importSource = path.join(vaultPath, 'import.md')
  await fs.writeFile(importSource, '# Imported\n\nImported body', 'utf-8')
  const importResult = await app.importFiles({
    sourcePaths: [importSource],
    targetFolder: 'Projects'
  })
  assert.equal(importResult.imported, 1)
  assert.equal(importResult.importedFiles[0]?.destPath, path.join(vaultPath, 'Projects/import.md'))

  const htmlExportPath = path.join(vaultPath, 'cli-note.html')
  const markdownExportPath = path.join(vaultPath, 'cli-note.md')
  const pdfExportPath = path.join(vaultPath, 'cli-note.pdf')
  assert.equal(
    (await app.exportHtml(note.id, htmlExportPath, { includeMetadata: true })).path,
    htmlExportPath
  )
  assert.match(await fs.readFile(htmlExportPath, 'utf-8'), /Body from the command line/)
  assert.equal((await app.exportMarkdown(note.id, markdownExportPath)).path, markdownExportPath)
  assert.match(await fs.readFile(markdownExportPath, 'utf-8'), /Body from the command line/)
  assert.equal(
    (await app.exportPdf(note.id, pdfExportPath, { includeMetadata: true })).path,
    pdfExportPath
  )
  assert.match(await fs.readFile(pdfExportPath, 'utf-8'), /^%PDF-/)

  const linkedNote = await app.notes.create({
    title: 'Linked Note',
    content: 'Linked body',
    folder: 'Research'
  })
  await app.notes.update({ id: note.id, append: '[[Linked Note]] [[Missing Note]]' })
  assert.equal(await app.notes.exists(note.id), true)
  assert.equal((await app.notes.previewByTitle('Linked Note'))?.id, linkedNote.id)
  assert.equal((await app.notes.resolveByTitle('Linked Note'))?.path, linkedNote.path)
  // #1557: a wiki-link target, not a bare title — the note half resolves and
  // the heading half comes back for the caller to scroll to.
  assert.equal(await app.notes.resolveByTitle('Linked Note#Details'), null)
  const headingTarget = await app.notes.resolveWikiTarget('Linked Note#Details')
  assert.equal(headingTarget?.path, linkedNote.path)
  assert.equal(headingTarget?.heading, 'Details')
  assert.equal((await app.notes.resolveWikiTarget('Linked Note'))?.heading, null)
  assert.equal(await app.notes.resolveWikiTarget('Missing Note#Details'), null)
  const noteLinks = await app.notes.getLinks(note.id)
  assert.equal(
    noteLinks.outgoing.some(
      (link) => link.title === 'Linked Note' && link.noteId === linkedNote.id
    ),
    true
  )
  assert.equal(
    noteLinks.outgoing.some((link) => link.title === 'Missing Note' && link.noteId === null),
    true
  )

  await app.journal.append('2026-05-13', 'CLI journal line')
  const journal = await app.journal.get('2026-05-13')
  assert.match(journal?.content ?? '', /CLI journal line/)
  await app.notes.update({ id: journal?.id ?? '', tags: ['daily'] })
  assert.deepEqual(await app.journal.allTags(), [{ tag: 'daily', count: 1 }])
  assert.equal((await app.journal.month(2026, 5))[0]?.journalDate, '2026-05-13')
  assert.equal((await app.journal.yearStats(2026)).entries, 1)
  assert.ok((await app.journal.heatmap(2026)).some((entry) => entry.date === '2026-05-13'))
  await app.journal.write('2026-05-12', 'Temporary journal')
  assert.equal(await app.journal.delete('2026-05-12'), true)

  assert.equal((await app.sync.status()).status, 'idle')
  assert.deepEqual(await app.sync.queueSize(), { pending: 0, failed: 0, deadLetter: 0, total: 0 })
  assert.equal((await app.sync.devices()).devices.length, 0)
  assert.equal((await app.sync.history()).total, 0)
  assert.equal((await app.sync.pause()).success, true)
  assert.equal((await app.sync.status()).status, 'paused')
  assert.equal((await app.sync.resume()).success, true)
  assert.equal(await app.sync.getSyncedSettings(), null)
  assert.equal((await app.sync.updateSyncedSetting('sync.autoSync', false)).success, true)
  assert.equal((await app.sync.getSyncedSettings())?.sync?.autoSync, false)
  assert.equal((await app.sync.storageBreakdown()).used > 0, true)
  assert.deepEqual(await app.sync.checkDeviceStatus(), { status: 'unknown' })
  const quarantineDatabases = openDatabases(vaultPath)
  try {
    quarantineDatabases.dataDb
      .insert(syncState)
      .values({
        key: 'quarantinedItems',
        value: JSON.stringify([
          {
            itemId: 'item-1',
            itemType: 'task',
            signerDeviceId: 'device-1',
            failedAt: 1770000000000,
            attemptCount: 3,
            lastError: 'bad signature'
          }
        ]),
        updatedAt: new Date()
      })
      .run()
  } finally {
    quarantineDatabases.close()
  }
  assert.deepEqual(await app.sync.quarantinedItems(), [
    {
      itemId: 'item-1',
      itemType: 'task',
      signerDeviceId: 'device-1',
      failedAt: 1770000000000,
      attemptCount: 3,
      lastError: 'bad signature',
      permanent: true
    }
  ])

  const agentStatuses = await app.agent.backendStatuses()
  assert.equal(agentStatuses.claude_cli.backend, 'claude_cli')
  assert.equal(agentStatuses.codex_cli.backend, 'codex_cli')
  assert.equal(agentStatuses.local_openai_compatible.backend, 'local_openai_compatible')

  assert.deepEqual(await app.agent.backendModels('codex_cli'), {
    backend: 'codex_cli',
    supportsCustomModel: true,
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' }
    ]
  })

  assert.deepEqual(await app.agent.getLocalProviderSettings(), {
    preset: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    apiKeyConfigured: false,
    allowNonLoopback: false
  })
  assert.deepEqual(
    await app.agent.setLocalProviderSettings({
      preset: 'lm_studio',
      model: 'qwen',
      allowNonLoopback: false
    }),
    {
      preset: 'lm_studio',
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen',
      apiKeyConfigured: false,
      allowNonLoopback: false
    }
  )

  const repeatConfig = {
    frequency: 'daily',
    interval: 1,
    endType: 'never',
    completedCount: 0,
    createdAt: '2026-05-13T00:00:00.000Z'
  }
  const task = await app.tasks.create({
    title: 'CLI task',
    priority: 2,
    tags: ['cli'],
    linkedNoteIds: [note.id, linkedNote.id],
    sourceNoteId: note.id,
    repeatConfig,
    repeatFrom: 'due'
  })
  assert.equal(task.title, 'CLI task')
  assert.deepEqual(task.linkedNoteIds.sort(), [linkedNote.id, note.id].sort())
  assert.deepEqual(task.repeatConfig, repeatConfig)
  assert.equal(task.sourceNoteId, note.id)
  const taskProject = await app.tasks.projects.create({
    name: 'Task Project',
    description: 'Task project description'
  })
  assert.deepEqual(
    (await app.tasks.projects.statuses('inbox'))
      .sort((a, b) => a.position - b.position)
      .map((status) => status.name),
    ['To Do', 'In Progress', 'Done']
  )
  assert.deepEqual(
    (await app.tasks.projects.statuses(taskProject.id))
      .sort((a, b) => a.position - b.position)
      .map((status) => status.name),
    ['To Do', 'In Progress', 'Done']
  )
  assert.equal(
    (await app.tasks.projects.update(taskProject.id, { name: 'Task Project Updated' })).name,
    'Task Project Updated'
  )
  const reviewStatus = await app.tasks.projects.createStatus(taskProject.id, {
    name: 'Review',
    color: '#0ea5e9'
  })
  assert.equal(
    (await app.tasks.projects.statuses(taskProject.id)).some(
      (status) => status.id === reviewStatus.id
    ),
    true
  )
  assert.equal(
    (
      await app.tasks.projects.updateStatus(reviewStatus.id, {
        name: 'Reviewed',
        isDone: true
      })
    )?.name,
    'Reviewed'
  )
  assert.equal(
    (
      await app.tasks.move(task.id, {
        projectId: taskProject.id,
        statusId: reviewStatus.id,
        position: 0
      })
    ).statusId,
    reviewStatus.id
  )
  assert.deepEqual(
    (
      await app.tasks.update(task.id, {
        linkedNoteIds: [linkedNote.id],
        repeatConfig: null,
        repeatFrom: null,
        sourceNoteId: null
      })
    ).linkedNoteIds,
    [linkedNote.id]
  )
  const childTask = await app.tasks.create({
    title: 'Child task',
    projectId: taskProject.id,
    parentId: task.id,
    dueDate: '2026-05-12',
    tags: ['child']
  })
  assert.equal((await app.tasks.getSubtasks(task.id))[0]?.id, childTask.id)
  assert.equal(
    (await app.tasks.getLinkedTasks(linkedNote.id)).some((linkedTask) => linkedTask.id === task.id),
    true
  )
  assert.equal((await app.tasks.convertToTask(childTask.id)).parentId, null)
  assert.equal((await app.tasks.convertToSubtask(childTask.id, task.id)).parentId, task.id)
  assert.equal(
    (await app.tasks.today('2026-05-12')).some((dueTask) => dueTask.id === childTask.id),
    true
  )
  assert.equal(
    (await app.tasks.upcoming({ days: 3, fromDate: '2026-05-12' })).some(
      (dueTask) => dueTask.id === childTask.id
    ),
    true
  )
  assert.equal(
    (await app.tasks.overdue('2026-05-13')).some((dueTask) => dueTask.id === childTask.id),
    true
  )
  const dayContext = await app.journal.dayContext('2026-05-12')
  assert.equal(
    dayContext.tasks.some((dayTask) => dayTask.id === childTask.id),
    true
  )
  assert.equal((await app.journal.dayContext('2026-05-13')).overdueCount >= 1, true)
  assert.ok((await app.tasks.stats('2026-05-13')).total >= 2)
  assert.equal(
    (await app.tasks.getTags()).some((tag) => tag.tag === 'child' && tag.count === 1),
    true
  )
  const secondTaskProject = await app.tasks.projects.create({ name: 'Second Task Project' })
  assert.equal(await app.tasks.bulkMove([childTask.id], secondTaskProject.id), 1)
  assert.equal((await app.tasks.get(childTask.id))?.projectId, secondTaskProject.id)
  assert.equal(await app.tasks.reorder([childTask.id, task.id], [0, 1]), true)
  assert.equal((await app.tasks.projects.get(taskProject.id))?.id, taskProject.id)
  assert.equal(
    await app.tasks.projects.reorder([secondTaskProject.id, taskProject.id], [0, 1]),
    true
  )
  assert.equal(await app.tasks.projects.reorderStatuses([reviewStatus.id], [0]), true)
  assert.equal((await app.tasks.duplicate(task.id)).title, 'Copy of CLI task')
  const bulkA = await app.tasks.create({ title: 'Bulk A' })
  const bulkB = await app.tasks.create({ title: 'Bulk B' })
  assert.equal(await app.tasks.bulkComplete([bulkA.id, bulkB.id]), 2)
  assert.equal(await app.tasks.bulkArchive([bulkA.id, bulkB.id]), 2)
  assert.equal(await app.tasks.bulkDelete([bulkA.id, bulkB.id]), 2)
  await app.tasks.complete(task.id)
  assert.ok((await app.tasks.get(task.id))?.completedAt)
  assert.equal((await app.tasks.reopen(task.id)).completedAt, null)
  assert.ok((await app.tasks.archive(task.id)).archivedAt)
  assert.equal((await app.tasks.unarchive(task.id)).archivedAt, null)
  assert.equal(await app.tasks.projects.deleteStatus(reviewStatus.id), true)
  const disposableProject = await app.tasks.projects.create({ name: 'Disposable Project' })
  assert.ok((await app.tasks.projects.archive(disposableProject.id)).archivedAt)
  assert.equal((await app.tasks.projects.unarchive(disposableProject.id)).archivedAt, null)
  assert.equal(await app.tasks.projects.delete(disposableProject.id), true)

  const inboxItem = await app.inbox.captureText({
    title: 'CLI inbox',
    content: 'Remember this',
    tags: ['cli']
  })
  assert.equal(inboxItem.title, 'CLI inbox')
  assert.equal((await app.inbox.list()).items.length, 1)
  assert.equal((await app.inbox.get(inboxItem.id))?.id, inboxItem.id)
  assert.equal(
    (await app.inbox.update(inboxItem.id, { title: 'CLI inbox updated' })).title,
    'CLI inbox updated'
  )
  assert.equal((await app.inbox.addTag(inboxItem.id, 'follow-up')).tags.includes('follow-up'), true)
  assert.equal(
    (await app.inbox.removeTag(inboxItem.id, 'follow-up')).tags.includes('follow-up'),
    false
  )
  assert.deepEqual(await app.inbox.tags(), [{ tag: 'cli', count: 1 }])
  assert.equal((await app.inbox.stats()).totalItems, 1)
  assert.ok((await app.inbox.markViewed(inboxItem.id)).viewedAt)
  const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  assert.equal(
    (await app.inbox.snooze(inboxItem.id, snoozedUntil, 'Later')).snoozedUntil,
    snoozedUntil
  )
  assert.equal((await app.inbox.list()).items.length, 0)
  assert.equal((await app.inbox.list({ includeSnoozed: true })).items.length, 1)
  assert.equal((await app.inbox.snoozed()).items[0]?.id, inboxItem.id)
  assert.equal((await app.inbox.unsnooze(inboxItem.id)).snoozedUntil, null)
  assert.ok((await app.inbox.archive(inboxItem.id)).archivedAt)
  assert.equal((await app.inbox.unarchive(inboxItem.id)).archivedAt, null)

  const linkCapture = await app.inbox.captureLink({
    url: 'https://example.com/articles/memry-cli',
    tags: ['reading']
  })
  assert.equal(linkCapture.type, 'link')
  assert.equal(linkCapture.sourceUrl, 'https://example.com/articles/memry-cli')
  assert.deepEqual(linkCapture.tags, ['reading'])
  const convertedNote = await app.inbox.convertToNote(linkCapture.id)
  assert.equal(convertedNote.success, true)
  assert.ok(convertedNote.noteId)
  assert.equal((await app.inbox.get(linkCapture.id))?.filedAction, 'note')
  assert.ok(await app.notes.get(convertedNote.noteId ?? ''))

  const taskCapture = await app.inbox.captureText({
    title: 'Task from inbox',
    content: 'Turn this into a task',
    tags: ['triage']
  })
  const convertedTask = await app.inbox.convertToTask(taskCapture.id)
  assert.equal(convertedTask.success, true)
  assert.ok(convertedTask.taskId)
  assert.equal((await app.tasks.get(convertedTask.taskId ?? ''))?.title, 'Task from inbox')

  const targetNote = await app.notes.create({ title: 'Inbox Target', content: 'Target body' })
  const linkToNoteCapture = await app.inbox.captureText({
    title: 'Linked inbox note',
    content: 'Capture to link'
  })
  assert.equal((await app.inbox.linkToNote(linkToNoteCapture.id, targetNote.id)).success, true)
  assert.match((await app.notes.get(targetNote.id))?.content ?? '', /## Inbox Captures/)
  assert.equal((await app.inbox.get(linkToNoteCapture.id))?.filedAction, 'linked')

  const inboxImageSource = path.join(vaultPath, 'sample.png')
  await fs.writeFile(inboxImageSource, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const imageCapture = await app.inbox.captureFile({
    filePath: inboxImageSource,
    mimeType: 'image/png',
    tags: ['image']
  })
  assert.equal(imageCapture.type, 'image')
  assert.ok(imageCapture.attachmentPath?.startsWith(`attachments/inbox/${imageCapture.id}/`))
  assert.equal(imageCapture.tags.includes('image'), true)
  await fs.access(path.join(vaultPath, imageCapture.attachmentPath ?? 'missing'))
  assert.equal(await app.inbox.getStaleThreshold(), 7)
  assert.deepEqual(await app.inbox.setStaleThreshold(14), { success: true })
  assert.equal(await app.inbox.getStaleThreshold(), 14)
  assert.equal((await app.inbox.filingHistory({ limit: 10 })).entries.length >= 3, true)

  const batchA = await app.inbox.captureText({ title: 'Batch A', content: 'A' })
  const batchB = await app.inbox.captureText({ title: 'Batch B', content: 'B' })
  assert.deepEqual(await app.inbox.bulkTag([batchA.id, batchB.id], ['batch']), {
    success: true,
    processedCount: 2,
    errors: []
  })
  assert.equal((await app.inbox.get(batchA.id))?.tags.includes('batch'), true)
  const futureSnoozeDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  assert.deepEqual(await app.inbox.bulkSnooze([batchA.id, batchB.id], futureSnoozeDate), {
    success: true,
    processedCount: 2,
    errors: []
  })
  assert.equal(
    (await app.inbox.snoozed()).items.some((item) => item.id === batchB.id),
    true
  )
  assert.deepEqual(await app.inbox.bulkArchive([batchA.id, batchB.id]), {
    success: true,
    processedCount: 2,
    errors: []
  })
  assert.equal((await app.inbox.archived({ limit: 10 })).items.length >= 2, true)
  const inboxPatterns = await app.inbox.patterns()
  assert.equal(inboxPatterns.timeHeatmap.length, 24)
  assert.equal(
    inboxPatterns.timeHeatmap.every((hour) => hour.length === 7),
    true
  )
  assert.equal(
    inboxPatterns.typeDistribution.some(
      (entry) => entry.type === 'link' && entry.count >= 1 && entry.percentage > 0
    ),
    true
  )
  assert.equal(
    inboxPatterns.topDomains.some((domain) => domain.domain === 'example.com'),
    true
  )
  assert.equal(
    inboxPatterns.topTags.some((tag) => tag.tag === 'cli'),
    true
  )

  assert.equal(await app.folderView.exists('Projects'), true)
  assert.equal((await app.folderView.getViews('Projects')).views[0]?.name, 'Table')
  const folderRows = await app.folderView.listWithProperties({
    folderPath: 'Projects',
    limit: 20
  })
  assert.equal(folderRows.total, 2)
  assert.deepEqual(folderRows.notes.find((row) => row.id === note.id)?.properties, {
    state: 'active',
    priority: 3
  })
  const availableProperties = await app.folderView.getAvailableProperties('Projects')
  assert.ok(availableProperties.properties.some((property) => property.name === 'state'))
  await app.folders.create('Reference')
  const folderSuggestions = await app.folderView.getFolderSuggestions(note.id)
  assert.equal(
    folderSuggestions.suggestions.some((suggestion) => suggestion.path === 'Reference'),
    true
  )

  const tags = await app.tags.list()
  const cliTag = tags.find((tag) => tag.name === 'cli')
  assert.equal(cliTag?.totalCount, 4)

  await app.tags.setColor('cli', '#123456')
  await app.tags.rename('cli', 'command-line')
  assert.equal(
    (await app.tags.list()).some((tag) => tag.name === 'command-line'),
    true
  )
  const tagNote = await app.notes.create({
    title: 'Tagged CLI Note',
    content: 'Tag management',
    tags: ['source-tag']
  })
  assert.equal(
    (await app.tags.notes('source-tag')).unpinnedNotes.some(
      (taggedNote) => taggedNote.id === tagNote.id
    ),
    true
  )
  assert.deepEqual(await app.tags.merge('source-tag', 'target-tag'), {
    success: true,
    affectedItems: 1
  })
  assert.equal(
    (await app.tags.notes('target-tag')).unpinnedNotes.some(
      (taggedNote) => taggedNote.id === tagNote.id
    ),
    true
  )
  assert.deepEqual(await app.tags.removeFromNote(tagNote.id, 'target-tag'), { success: true })
  assert.equal((await app.notes.get(tagNote.id))?.tags.includes('target-tag'), false)

  await app.settings.set('editor.spellcheck', true)
  assert.equal((await app.settings.get('editor.spellcheck'))?.value, true)
  assert.equal((await app.settings.ai()).enabled, true)
  assert.deepEqual(await app.settings.setAi({ enabled: false }), { enabled: false })
  assert.deepEqual(await app.settings.ai(), { enabled: false })
  assert.deepEqual(await app.settings.getGroup('journal'), {
    defaultTemplate: null,
    showSchedule: true,
    showTasks: true,
    showAIConnections: true,
    showStatsFooter: false
  })
  assert.deepEqual(
    await app.settings.setGroup('journal', {
      defaultTemplate: 'Daily Review',
      showSchedule: false,
      showStatsFooter: true
    }),
    {
      defaultTemplate: 'Daily Review',
      showSchedule: false,
      showTasks: true,
      showAIConnections: true,
      showStatsFooter: true
    }
  )
  assert.deepEqual(await app.settings.setGroup('tabs', { tabCloseButton: 'always' }), {
    restoreSessionOnStart: true,
    tabCloseButton: 'always'
  })
  assert.deepEqual(await app.settings.setGroup('noteEditor', { toolbarMode: 'sticky' }), {
    toolbarMode: 'sticky'
  })
  assert.deepEqual(await app.settings.getGroup('general'), {
    theme: 'white',
    fontSize: 'medium',
    fontFamily: 'system',
    accentColor: '#6366f1',
    startOnBoot: false,
    language: 'en',
    onboardingCompleted: false,
    createInSelectedFolder: true,
    clockFormat: '12h',
    dateFormat: 'DD.MM.YYYY'
  })
  assert.deepEqual(await app.settings.setGroup('general', { theme: 'dark', language: 'tr' }), {
    theme: 'dark',
    fontSize: 'medium',
    fontFamily: 'system',
    accentColor: '#6366f1',
    startOnBoot: false,
    language: 'tr',
    onboardingCompleted: false,
    createInSelectedFolder: true,
    clockFormat: '12h',
    dateFormat: 'DD.MM.YYYY'
  })
  assert.equal(await app.locale.get(), 'tr')
  assert.equal((await app.locale.list()).includes('de'), true)
  assert.deepEqual(await app.locale.set('de'), { locale: 'de' })
  assert.equal(await app.locale.get(), 'de')
  assert.equal((await app.settings.getGroup('general')).language, 'de')
  const configAfterLocale = JSON.parse(
    await fs.readFile(path.join(vaultPath, '.memry', 'config.json'), 'utf-8')
  ) as { preferences?: { language?: string } }
  assert.equal(configAfterLocale.preferences?.language, 'de')

  assert.deepEqual(await app.settings.setGroup('voiceTranscription', { provider: 'openai' }), {
    provider: 'openai',
    memoNameMode: 'transcript'
  })
  assert.deepEqual(await app.settings.getGroup('graph'), {
    layout: 'forceatlas2',
    showLabels: false,
    showEdgeLabels: false,
    animateLayout: true,
    showTagEdges: false
  })

  const reminder = await app.reminders.create({
    targetType: 'note',
    targetId: note.id,
    remindAt: '2026-05-14T08:00:00.000Z',
    title: 'Review CLI note'
  })
  assert.equal(reminder.status, 'pending')
  assert.equal((await app.reminders.list({ status: 'pending' })).total, 1)
  assert.equal(
    (
      await app.reminders.update({
        id: reminder.id,
        remindAt: '2026-05-15T08:00:00.000Z',
        title: 'Review CLI note again',
        note: 'Updated reminder note'
      })
    )?.title,
    'Review CLI note again'
  )
  assert.equal((await app.reminders.forTarget('note', note.id)).length, 1)
  assert.equal(await app.reminders.countPending(), 1)
  const secondReminder = await app.reminders.create({
    targetType: 'note',
    targetId: note.id,
    remindAt: '2026-05-16T08:00:00.000Z',
    title: 'Second reminder'
  })
  assert.deepEqual(await app.reminders.bulkDismiss([reminder.id, secondReminder.id]), {
    success: true,
    dismissedCount: 2
  })
  assert.equal(await app.reminders.countPending(), 0)
  assert.equal((await app.reminders.dismiss(reminder.id)).status, 'dismissed')

  const template = await app.templates.create({
    name: 'CLI Template',
    content: 'Template body',
    tags: ['templates']
  })
  assert.equal((await app.templates.get(template.id))?.content, 'Template body\n')
  assert.equal((await app.templates.list()).length, 1)

  const bookmark = await app.bookmarks.add({ itemType: 'note', itemId: note.id })
  assert.equal(bookmark.itemId, note.id)
  assert.equal((await app.bookmarks.get(bookmark.id))?.id, bookmark.id)
  assert.equal(await app.bookmarks.has('note', note.id), true)
  assert.equal((await app.bookmarks.list()).length, 1)
  assert.equal(
    (await app.bookmarks.toggle({ itemType: 'note', itemId: note.id })).bookmarked,
    false
  )
  assert.equal((await app.bookmarks.toggle({ itemType: 'note', itemId: note.id })).bookmarked, true)
  const bookmarks = await app.bookmarks.list()
  await app.bookmarks.reorder(bookmarks.map((item) => item.id).reverse())
  assert.equal((await app.bookmarks.getByItem('note', note.id))?.itemId, note.id)
  const bulkBookmarks = await app.bookmarks.bulkCreate([
    { itemType: 'task', itemId: childTask.id },
    { itemType: 'template', itemId: template.id }
  ])
  assert.equal(bulkBookmarks.length, 2)
  assert.equal((await app.bookmarks.list({ itemType: 'task' })).length, 1)
  assert.equal(await app.bookmarks.bulkDelete(bulkBookmarks.map((item) => item.id)), true)
  assert.equal((await app.bookmarks.list({ itemType: 'task' })).length, 0)

  const savedFilter = await app.savedFilters.create({
    name: 'CLI Filter',
    config: { query: 'CLI', tags: ['command-line'] }
  })
  assert.deepEqual((await app.savedFilters.get(savedFilter.id))?.config, {
    query: 'CLI',
    tags: ['command-line']
  })
  assert.equal(
    (await app.savedFilters.update(savedFilter.id, { name: 'CLI Filter Updated' })).name,
    'CLI Filter Updated'
  )
  const secondSavedFilter = await app.savedFilters.create({
    name: 'Second CLI Filter',
    config: { query: 'second' }
  })
  assert.deepEqual(
    (await app.savedFilters.reorder([secondSavedFilter.id, savedFilter.id], [0, 1])).map(
      (filter) => filter.id
    ),
    [secondSavedFilter.id, savedFilter.id]
  )

  const calendarEvent = await app.calendar.events.create({
    title: 'CLI event',
    description: 'Created from app-core',
    startAt: '2026-05-14T09:00:00.000Z',
    endAt: '2026-05-14T10:00:00.000Z',
    timezone: 'UTC'
  })
  assert.equal((await app.calendar.events.get(calendarEvent.id))?.title, 'CLI event')
  assert.equal((await app.calendar.events.list()).length, 1)
  assert.equal(
    (await app.calendar.events.update(calendarEvent.id, { location: 'Desk' })).location,
    'Desk'
  )
  assert.equal((await app.calendar.sources.list()).sources.length, 0)
  assert.equal((await app.calendar.providerStatus({ provider: 'google' })).connected, false)
  assert.deepEqual(await app.calendar.googleSettings(), {
    defaultTargetCalendarId: null,
    onboardingCompleted: false,
    promoteConfirmDismissed: false
  })
  assert.equal((await app.calendar.setDefaultGoogleCalendar('work-calendar', false)).success, true)
  assert.deepEqual(await app.calendar.googleSettings(), {
    defaultTargetCalendarId: 'work-calendar',
    onboardingCompleted: false,
    promoteConfirmDismissed: false
  })
  seedExternalCalendarEvent(vaultPath)
  assert.equal((await app.calendar.sources.list({ provider: 'google' })).sources.length, 1)
  assert.equal(
    (await app.calendar.external.list({ sourceId: 'calendar_source_google_work' })).events[0]
      ?.title,
    'Imported external event'
  )
  const calendarRange = await app.calendar.range({
    startAt: '2026-05-12T00:00:00.000Z',
    endAt: '2026-05-16T00:00:00.000Z'
  })
  assert.equal(
    calendarRange.items.some(
      (item) => item.sourceType === 'event' && item.sourceId === calendarEvent.id
    ),
    true
  )
  assert.equal(
    calendarRange.items.some(
      (item) => item.sourceType === 'task' && item.sourceId === childTask.id
    ),
    true
  )
  assert.equal(
    calendarRange.items.some(
      (item) => item.sourceType === 'external_event' && item.sourceId === 'external_event_1'
    ),
    true
  )
  assert.equal((await app.calendar.bindings.list({ provider: 'google' })).bindings.length, 0)
  const promoted = await app.calendar.external.promote('external_event_1')
  assert.equal(promoted.success, true)
  const promotedEvent = await app.calendar.events.get(promoted.eventId ?? '')
  assert.equal(promotedEvent?.title, 'Imported external event')
  assert.equal(promotedEvent?.targetCalendarId, 'work-calendar')
  assert.equal((await app.calendar.external.get('external_event_1'))?.archivedAt !== null, true)
  const promotedBindings = await app.calendar.bindings.list({
    sourceType: 'event',
    sourceId: promoted.eventId ?? ''
  })
  assert.equal(promotedBindings.bindings[0]?.remoteEventId, 'remote-event-1')
  assert.equal(promotedBindings.bindings[0]?.ownershipMode, 'provider_managed')
  assert.equal((await app.calendar.external.promote('external_event_1')).eventId, promoted.eventId)
  assert.equal((await app.calendar.bindings.list({ provider: 'google' })).bindings.length, 1)

  const results = await app.search('CLI')
  const resultKinds = results.map((result) => result.kind)
  for (const kind of ['calendar', 'inbox', 'journal', 'note', 'reminder', 'task', 'template']) {
    assert.ok(resultKinds.includes(kind))
  }
  const searchStats = await app.searchStats()
  assert.ok(searchStats.totalNotes >= 3)
  await app.searchReasons.add({
    itemId: note.id,
    itemType: 'note',
    itemTitle: note.title,
    searchQuery: 'CLI'
  })
  assert.equal((await app.searchReasons.list())[0]?.itemId, note.id)
  const appSearchTags = await app.searchTags()
  for (const tag of ['child', 'command-line', 'templates']) {
    assert.ok(appSearchTags.includes(tag))
  }

  const fileNote = await app.notes.create({ title: 'File Note', content: 'Move me' })
  assert.equal(
    (await app.notes.rename(fileNote.id, 'Renamed File Note')).title,
    'Renamed File Note'
  )
  const movedFileNote = await app.notes.move(fileNote.id, 'Moved')
  assert.match(movedFileNote.path, /^Moved\//)
  assert.equal((await app.notes.setLocalOnly(movedFileNote.id, true)).localOnly, true)
  assert.equal((await app.notes.localOnlyCount()).count, 1)

  const graph = await app.graph.data()
  assert.ok(graph.edges.some((edge) => edge.source === note.id && edge.target === linkedNote.id))
  assert.ok(graph.nodes.some((node) => node.id === 'ghost:Missing Note' && node.isUnresolved))
  assert.ok((await app.graph.local(note.id, 1)).nodes.some((node) => node.id === linkedNote.id))

  app.close()
})
