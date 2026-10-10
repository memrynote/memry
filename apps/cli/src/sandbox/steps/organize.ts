import { noteReminderSyncId } from '@memry/contracts/reminder-types'

import {
  folderIcons,
  folderTemplates,
  looseTagColors,
  savedFilterSpecs,
  tagCategories,
  templateSpecs
} from '../content/organize.ts'
import { need, type SandboxStep } from '../context.ts'

export const organize: SandboxStep = async (ctx) => {
  const { app, clock } = ctx

  for (const category of tagCategories) {
    for (const [tag, color] of Object.entries(category.tags)) await app.tags.setColor(tag, color)
  }
  for (const [tag, color] of Object.entries(looseTagColors)) await app.tags.setColor(tag, color)

  for (const spec of templateSpecs) {
    const template = await app.templates.create({
      name: spec.name,
      description: spec.description,
      icon: spec.icon,
      tags: spec.tags,
      properties: spec.properties,
      content: spec.content
    })
    ctx.templates.set(spec.key, template.id)
  }
  await app.settings.setGroup('journal', {
    defaultTemplate: need(ctx.templates, 'journal', 'template')
  })

  for (const [folder, icon] of Object.entries(folderIcons)) {
    const template = folderTemplates[folder]
    await app.folderView.setConfig(folder, {
      icon,
      ...(template ? { template: need(ctx.templates, template, 'template') } : {})
    })
  }

  // Reading list and Recipes are folder views over the same notes as the Book
  // and Recipe tag tables: a folder view follows the folder, a tag table the tag.
  await app.folderView.setView('Research/Reading list', {
    name: 'Shelf',
    type: 'table',
    default: true,
    columns: [
      { id: 'title', width: 240 },
      { id: 'Author', width: 180 },
      { id: 'Shelf' },
      { id: 'Rating', showSummary: true },
      { id: 'topics', width: 220 },
      { id: 'Finished' }
    ],
    order: [{ property: 'Rating', direction: 'desc' }],
    showSummaries: true
  })
  await app.folderView.setView('Research/Reading list', {
    name: 'Cards',
    type: 'grid',
    columns: [{ id: 'title' }, { id: 'Author' }, { id: 'Shelf' }]
  })
  await app.folderView.setView('Research/Reading list', {
    name: 'Finished',
    type: 'list',
    filters: { and: ['Shelf == "Read"'] },
    order: [{ property: 'Finished', direction: 'desc' }]
  })
  await app.folderView.setView('Kitchen/Recipes', {
    name: 'Gallery',
    type: 'grid',
    default: true,
    columns: [{ id: 'title' }, { id: 'Course' }, { id: 'Time' }, { id: 'Rating' }]
  })
  await app.folderView.setView('Kitchen/Recipes', {
    name: 'By course',
    type: 'table',
    columns: [
      { id: 'title', width: 260 },
      { id: 'Course' },
      { id: 'Time' },
      { id: 'Servings' },
      { id: 'tried' }
    ],
    groupBy: { property: 'Course' }
  })
  await app.folderView.setView('Notes 101', {
    name: 'Chapters',
    type: 'table',
    default: true,
    columns: [{ id: 'title', width: 300 }, { id: 'level', width: 140 }, { id: 'summary' }],
    order: [{ property: 'title', direction: 'asc' }]
  })
  await app.folderView.setView('Work/Aurora/Meetings', {
    name: 'Meetings',
    type: 'list',
    default: true,
    order: [{ property: 'created', direction: 'desc' }]
  })

  for (const spec of savedFilterSpecs) {
    await app.savedFilters.create({
      name: spec.name,
      config: {
        filters: {
          ...spec.filters,
          projectIds: spec.projectKey ? [need(ctx.projects, spec.projectKey, 'project').id] : []
        },
        sort: spec.sort,
        starred: spec.starred
      }
    })
  }

  const note = (key: string): string => need(ctx.notes, key, 'note').id
  const task = (key: string): string => need(ctx.tasks, key, 'task').id
  const file = (key: string): string => need(ctx.files, key, 'file').id
  const bookmarks: Array<{ itemType: string; itemId: string }> = [
    { itemType: 'note', itemId: note('g-welcome') },
    { itemType: 'note', itemId: note('aurora-brief') },
    { itemType: 'journal', itemId: need(ctx.journal, clock.date(0), 'journal day') },
    { itemType: 'task', itemId: task('a-launch') },
    { itemType: 'folder', itemId: 'Research/Reading list' },
    { itemType: 'tag', itemId: 'space-race' },
    { itemType: 'canvas', itemId: need(ctx.canvasIds, 'aurora-map', 'canvas') },
    { itemType: 'pdf', itemId: file('gestures-pdf') },
    { itemType: 'image', itemId: file('pillars-image') },
    { itemType: 'audio', itemId: file('armstrong-audio') },
    { itemType: 'video', itemId: file('launch-video') }
  ]
  for (const [position, bookmark] of bookmarks.entries())
    await app.bookmarks.add({ ...bookmark, position })

  // Reminder ids: a note reminder uses its deterministic sync id, and a journal
  // reminder targets the date, as desktop's reminder-service does.
  await app.reminders.create({
    id: noteReminderSyncId(note('aurora-prd')),
    targetType: 'note',
    targetId: note('aurora-prd'),
    remindAt: clock.at(1, '09:00'),
    title: 'Close open PRD comments before the review'
  })
  await app.reminders.create({
    targetType: 'task',
    targetId: task('p-permits'),
    remindAt: clock.at(2, '07:30'),
    title: 'Permit reservations open at 8'
  })
  await app.reminders.create({
    targetType: 'journal',
    targetId: clock.date(1),
    remindAt: clock.at(1, '21:00'),
    title: 'Write about the library visit'
  })
  await app.reminders.create({
    targetType: 'highlight',
    targetId: note('r-safire'),
    remindAt: clock.at(3, '10:00'),
    highlightText: 'A note written so that nobody would ever have to read it.',
    note: 'Use as the last line of the essay?'
  })
  await app.reminders.create({
    id: noteReminderSyncId(note('k-meal-plan')),
    targetType: 'note',
    targetId: note('k-meal-plan'),
    remindAt: new Date(clock.now.getTime() - 60 * 60_000).toISOString(),
    title: 'Plan next week before the market'
  })
  const snoozed = await app.reminders.create({
    targetType: 'task',
    targetId: task('s-invoices'),
    remindAt: clock.ago(1, '09:00'),
    title: 'Invoices are overdue'
  })
  await app.reminders.snooze(snoozed.id, clock.at(1, '10:00'))
  const dismissed = await app.reminders.create({
    id: noteReminderSyncId(note('beta-retro')),
    targetType: 'note',
    targetId: note('beta-retro'),
    remindAt: clock.ago(5, '16:00'),
    title: 'Share the retro with the team'
  })
  await app.reminders.dismiss(dismissed.id)
}
