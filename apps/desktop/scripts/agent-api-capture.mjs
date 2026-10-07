#!/usr/bin/env node
/**
 * Fills scripts/agent-api-examples.json: runs every example call of the agent
 * API reference against a running app over MCP JSON-RPC and stores the reply.
 * Run it after adding a tool or an operation, then `agent-api:generate`.
 *
 *   pnpm --filter @memry/desktop exec electron-vite build
 *   node scripts/agent-app.mjs start          # throwaway vault, never a real one
 *   node scripts/agent-api-capture.mjs        # --verify compares replies instead of writing
 *   node scripts/agent-app.mjs stop
 *
 * Writes need a running Agent turn, so the script points Agent Chat at a fake
 * OpenAI-compatible model on 127.0.0.1, sends one message, and keeps that turn
 * open while it calls the write examples with the turn's write grant. Tool
 * approvals are set to Always allow for the session.
 *
 * In the stored calls and replies, ids of the seeded items read as tokens like
 * "<noteId>", the vault folder as "<vault>". Replies keep their first three array
 * entries and the first 300 characters of a string.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLES = path.join(here, 'agent-api-examples.json')
const VERIFY = process.argv.includes('--verify')
const REPORT =
  process.env.AGENT_API_REPORT ?? path.join(os.tmpdir(), 'agent-api-capture-report.json')
const require = createRequire(path.join(here, '../package.json'))
const { chromium } = require('@playwright/test')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const state = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8'))
const vault = state.vaultPath
if (!vault.startsWith(os.tmpdir()) && !vault.startsWith('/var/folders/')) {
  throw new Error(`Refusing to run against a vault outside the temp dir: ${vault}`)
}
const mainEval = (expression) =>
  execFileSync('node', [path.join(here, 'agent-app.mjs'), 'eval', expression], {
    encoding: 'utf8'
  }).trim()

// ---------------------------------------------------------------------------
// Files the import and capture examples read
// ---------------------------------------------------------------------------

const FILES = path.join(os.tmpdir(), 'memry-agent-api-examples')
fs.mkdirSync(FILES, { recursive: true })

function png(size) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = [0]
    for (let x = 0; x < size; x++) row.push(40 + x * 3, 90 + y * 2, 200)
    rows.push(Buffer.from(row))
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function pdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const stream = `BT /F1 18 Tf 24 72 Td (${text}) Tj ET`
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

const PNG = png(48)
const TINY_PNG = png(1)
/** Bytes as the object of byte values the binary capture schemas accept over JSON. */
const byteObject = (buf) => Object.fromEntries([...buf].map((byte, index) => [String(index), byte]))
const PDF = pdf('Quarterly report')
fs.writeFileSync(path.join(FILES, 'diagram.png'), PNG)
fs.writeFileSync(path.join(FILES, 'report.pdf'), PDF)
fs.writeFileSync(path.join(FILES, 'reading-list.md'), '# Reading list\n\n- Thinking in Systems\n')
fs.writeFileSync(path.join(FILES, 'brief.md'), '# Launch brief\n\nGoals for the relaunch.\n')
const exportDir = path.join(FILES, 'export')
fs.mkdirSync(exportDir, { recursive: true })

// ---------------------------------------------------------------------------
// Example calls. Tokens in angle brackets are filled from the seed.
// ---------------------------------------------------------------------------

const T = (name) => `<${name}>`
const W = 'w'
const R = 'r'

/** [key, kind ('tool' | 'op'), read or write, call, optional not_run reason] in run order. */
const CALLS = [
  // Named read tools
  ['vault_search_notes', 'tool', R, { query: 'relaunch', limit: 5 }],
  ['vault_read_note', 'tool', R, { id: T('noteId') }],
  ['vault_view_file', 'tool', R, { id: T('noteId'), attachment: T('attachmentName') }],
  ['vault_list_folder', 'tool', R, { path: 'Projects' }],
  ['vault_get_current_note', 'tool', R, {}],
  ['vault_list_tasks', 'tool', R, { status: 'open', project_id: T('projectId'), limit: 5 }],
  ['vault_get_task', 'tool', R, { id: T('taskId') }],
  ['vault_list_projects', 'tool', R, {}],
  ['vault_get_project', 'tool', R, { id: T('projectId') }],
  ['vault_list_statuses', 'tool', R, { project_id: T('projectId') }],
  ['vault_get_journal_entry', 'tool', R, { date: '2026-10-05' }],
  ['vault_list_journal_entries', 'tool', R, { from: '2026-10-01', to: '2026-10-31' }],
  ['vault_list_inbox_items', 'tool', R, { unread_only: false }],
  ['vault_get_inbox_item', 'tool', R, { id: T('inboxId') }],
  ['vault_get_tags', 'tool', R, {}],
  ['vault_list_canvases', 'tool', R, {}],
  ['vault_read_canvas', 'tool', R, { id: T('canvasId') }],
  ['vault_read_canvas_elements', 'tool', R, { id: T('canvasId') }],
  [
    'vault_desktop_read',
    'tool',
    R,
    { operation: 'notes.list', args: [{ folder: 'Projects', limit: 2 }] }
  ],
  ['vault_desktop_describe', 'tool', R, { operation: 'notes.ensurePropertyDefinition' }],

  // Desktop read operations
  ['notes.get', 'op', R, [T('noteId')]],
  ['notes.getByPath', 'op', R, ['Projects/Website relaunch plan.md']],
  ['notes.getFile', 'op', R, [T('fileId')]],
  ['notes.resolveByTitle', 'op', R, ['Launch checklist']],
  ['notes.resolveWikiTarget', 'op', R, ['Website relaunch plan#Goals']],
  ['notes.previewByTitle', 'op', R, ['Launch checklist']],
  ['notes.list', 'op', R, [{ folder: 'Projects', sortBy: 'title', limit: 3 }]],
  ['notes.getTags', 'op', R, []],
  ['notes.getLinks', 'op', R, [T('noteId')]],
  ['notes.getFolders', 'op', R, []],
  ['notes.exists', 'op', R, ['Launch checklist']],
  ['notes.getPropertyDefinitions', 'op', R, []],
  ['notes.listAttachments', 'op', R, [T('noteId')]],
  ['notes.getFolderConfig', 'op', R, ['Projects']],
  ['notes.getFolderTemplate', 'op', R, ['Projects']],
  ['notes.getVersions', 'op', R, [T('noteId')]],
  ['notes.getVersion', 'op', R, [T('snapshotId')]],
  ['notes.getPositions', 'op', R, ['Projects']],
  ['notes.getAllPositions', 'op', R, []],
  ['notes.getLocalOnlyCount', 'op', R, []],
  ['notes.getCalendarPropertyNames', 'op', R, []],
  ['tasks.get', 'op', R, [T('taskId')]],
  ['tasks.list', 'op', R, [{ projectId: T('projectId'), sortBy: 'priority', limit: 3 }]],
  ['tasks.getSubtasks', 'op', R, [T('taskId')]],
  ['tasks.getProject', 'op', R, [T('projectId')]],
  ['tasks.listProjects', 'op', R, []],
  ['tasks.listStatuses', 'op', R, [T('projectId')]],
  ['tasks.getTags', 'op', R, []],
  ['tasks.getStats', 'op', R, []],
  ['tasks.getToday', 'op', R, []],
  ['tasks.getUpcoming', 'op', R, [7]],
  ['tasks.getOverdue', 'op', R, []],
  ['tasks.getLinkedTasks', 'op', R, [T('noteId')]],
  ['tasks.listProjectLinks', 'op', R, [T('projectId')]],
  ['tasks.listProjectContents', 'op', R, [T('projectId')]],
  ['tasks.listForItem', 'op', R, ['note', T('noteId')]],
  ['inbox.get', 'op', R, [T('inboxId')]],
  ['inbox.list', 'op', R, [{ type: 'note', limit: 3 }]],
  ['inbox.previewLink', 'op', R, ['https://example.com/']],
  ['inbox.getSuggestions', 'op', R, [T('inboxId')]],
  ['inbox.getTags', 'op', R, []],
  ['inbox.getSnoozed', 'op', R, []],
  ['inbox.getStats', 'op', R, []],
  ['inbox.getJobs', 'op', R, [{ statuses: ['pending', 'running'] }]],
  ['inbox.getPatterns', 'op', R, []],
  ['inbox.getStaleThreshold', 'op', R, []],
  ['inbox.listArchived', 'op', R, [{ limit: 3 }]],
  ['inbox.getFilingHistory', 'op', R, [{ limit: 3 }]],
  ['journal.getEntry', 'op', R, ['2026-10-05']],
  ['journal.getHeatmap', 'op', R, [2026]],
  ['journal.getMonthEntries', 'op', R, [2026, 10]],
  ['journal.getYearStats', 'op', R, [2026]],
  ['journal.getDayContext', 'op', R, ['2026-10-05']],
  ['journal.getAllTags', 'op', R, []],
  ['journal.getStreak', 'op', R, []],
  ['properties.get', 'op', R, [T('noteId')]],
  ['templates.list', 'op', R, []],
  ['templates.get', 'op', R, [T('templateId')]],
  ['savedFilters.list', 'op', R, []],
  ['bookmarks.get', 'op', R, [T('bookmarkId')]],
  ['bookmarks.list', 'op', R, [{ itemType: 'note', limit: 3 }]],
  ['bookmarks.isBookmarked', 'op', R, [{ itemType: 'note', itemId: T('noteId') }]],
  ['bookmarks.listByType', 'op', R, ['note']],
  ['bookmarks.getByItem', 'op', R, [{ itemType: 'note', itemId: T('noteId') }]],
  ['tags.getNotesByTag', 'op', R, [{ tag: 'website', sortBy: 'title' }]],
  ['tags.getAllWithCounts', 'op', R, []],
  ['tags.listCategories', 'op', R, []],
  ['folderView.getConfig', 'op', R, ['Projects']],
  ['folderView.getViews', 'op', R, [{ kind: 'folder', path: 'Projects' }]],
  [
    'folderView.listWithProperties',
    'op',
    R,
    [{ scope: { kind: 'folder', path: 'Projects' }, properties: ['stage'], limit: 3 }]
  ],
  ['folderView.getAvailableProperties', 'op', R, [{ kind: 'folder', path: 'Projects' }]],
  ['folderView.getFolderSuggestions', 'op', R, [T('meetingNoteId')]],
  ['folderView.folderExists', 'op', R, ['Projects']],
  ['reminders.get', 'op', R, [T('reminderId')]],
  ['reminders.list', 'op', R, [{ targetType: 'note', status: 'pending', limit: 3 }]],
  ['reminders.getUpcoming', 'op', R, [30]],
  ['reminders.getDue', 'op', R, []],
  ['reminders.getForTarget', 'op', R, [{ targetType: 'note', targetId: T('noteId') }]],
  ['reminders.countPending', 'op', R, []],
  ['calendar.getEvent', 'op', R, [T('eventId')]],
  ['calendar.listEvents', 'op', R, [{ includeArchived: false }]],
  [
    'calendar.getRange',
    'op',
    R,
    [{ startAt: '2026-10-01T00:00:00.000Z', endAt: '2026-11-01T00:00:00.000Z' }]
  ],
  ['settings.get', 'op', R, ['agent-api-example']],
  ['settings.getJournalSettings', 'op', R, []],
  ['settings.getAISettings', 'op', R, []],
  ['settings.getVoiceTranscriptionSettings', 'op', R, []],
  ['settings.getVoiceModelStatus', 'op', R, []],
  ['settings.getVoiceRecordingReadiness', 'op', R, []],
  ['settings.getVoiceTranscriptionOpenAIKeyStatus', 'op', R, []],
  ['settings.getAIModelStatus', 'op', R, []],
  ['settings.getTabSettings', 'op', R, []],
  ['settings.getNoteEditorSettings', 'op', R, []],
  ['settings.getGeneralSettings', 'op', R, []],
  ['settings.getEditorSettings', 'op', R, []],
  ['settings.getTaskSettings', 'op', R, []],
  ['settings.getKeyboardSettings', 'op', R, []],
  ['settings.getSyncSettings', 'op', R, []],
  ['settings.getBackupSettings', 'op', R, []],
  ['settings.getGraphSettings', 'op', R, []],
  ['settings.getCalendarSettings', 'op', R, []],
  ['settings.getFeaturesSettings', 'op', R, []],
  ['settings.getInboxSettings', 'op', R, []],
  ['search.query', 'op', R, [{ text: 'relaunch', types: ['note', 'task'], limit: 3 }]],
  ['search.quick', 'op', R, ['launch', ['markdown']]],
  ['search.getStats', 'op', R, []],
  ['search.getReasons', 'op', R, []],
  ['search.getAllTags', 'op', R, []],
  ['graph.getData', 'op', R, []],
  ['graph.getLocal', 'op', R, [{ noteId: T('noteId'), depth: 1 }]],
  ['homePages.list', 'op', R, []],
  ['homePages.get', 'op', R, [T('homePageId')]],
  ['vault.getAll', 'op', R, []],
  ['vault.getStatus', 'op', R, []],
  ['vault.getConfig', 'op', R, []],
  ['vault.listAccount', 'op', R, []],
  ['canvas.list', 'op', R, []],
  ['canvas.getAsset', 'op', R, [T('canvasId'), 'missing-file-id']],
  ['canvas.listAssets', 'op', R, [T('canvasId')]],
  ['canvas.libraryList', 'op', R, []],

  // Named write tools
  [
    'vault_create_note',
    'tool',
    W,
    {
      title: 'Release notes draft',
      content_markdown: '# Release notes\n\n- New onboarding\n',
      folder_path: 'Projects',
      tags: ['website']
    }
  ],
  ['vault_rename_note', 'tool', W, { id: T('renameNoteId'), title: 'Q4 roadmap' }],
  [
    'vault_update_note',
    'tool',
    W,
    {
      id: T('noteId'),
      mode: 'append',
      content_markdown: '## Open questions\n\n- Who signs off the copy?\n'
    }
  ],
  [
    'vault_add_html_artifact',
    'tool',
    W,
    {
      id: T('noteId'),
      title: 'Launch timeline',
      html: '<h1>Launch timeline</h1><ol><li>Copy freeze</li><li>QA</li><li>Go live</li></ol>'
    }
  ],
  ['vault_move_to_folder', 'tool', W, { id: T('moveNoteId'), folder_path: 'Archive' }],
  ['vault_add_tag', 'tool', W, { id: T('noteId'), kind: 'note', tag: 'q4' }],
  ['vault_remove_tag', 'tool', W, { id: T('noteId'), kind: 'note', tag: 'q4' }],
  ['vault_create_folder', 'tool', W, { path: 'Projects/Research' }],
  [
    'vault_rename_folder',
    'tool',
    W,
    { old_path: 'Projects/Research', new_path: 'Projects/User research' }
  ],
  ['vault_delete_folder', 'tool', W, { path: 'Projects/User research' }],
  [
    'vault_create_task',
    'tool',
    W,
    {
      title: 'Book the launch venue',
      project_id: T('projectId'),
      due_date: '2026-10-20',
      priority: 2,
      tags: ['launch']
    }
  ],
  ['vault_update_task', 'tool', W, { id: T('taskId'), priority: 3, due_date: '2026-10-15' }],
  ['vault_complete_task', 'tool', W, { id: T('task2Id') }],
  ['vault_uncomplete_task', 'tool', W, { id: T('task2Id') }],
  ['vault_archive_task', 'tool', W, { id: T('task3Id') }],
  ['vault_unarchive_task', 'tool', W, { id: T('task3Id') }],
  [
    'vault_move_task',
    'tool',
    W,
    { task_id: T('task3Id'), target_status_id: T('statusDoingId'), position: 0 }
  ],
  ['vault_reorder_tasks', 'tool', W, { task_ids: [T('taskId'), T('task2Id')], positions: [1, 0] }],
  ['vault_duplicate_task', 'tool', W, { id: T('taskId') }],
  ['vault_convert_task_to_subtask', 'tool', W, { task_id: T('task4Id'), parent_id: T('taskId') }],
  ['vault_convert_subtask_to_task', 'tool', W, { id: T('task4Id') }],
  ['vault_create_project', 'tool', W, { name: 'Hiring', color: '#0ea5e9' }],
  [
    'vault_update_project',
    'tool',
    W,
    { id: T('project2Id'), description: 'Everything for the autumn hiring round.' }
  ],
  ['vault_archive_project', 'tool', W, { id: T('project2Id') }],
  [
    'vault_reorder_projects',
    'tool',
    W,
    { project_ids: [T('projectId'), T('project3Id')], positions: [1, 0] }
  ],
  [
    'vault_create_status',
    'tool',
    W,
    { project_id: T('projectId'), name: 'Blocked', color: '#ef4444' }
  ],
  ['vault_update_status', 'tool', W, { id: T('statusDoingId'), name: 'Doing' }],
  [
    'vault_reorder_statuses',
    'tool',
    W,
    { status_ids: [T('statusTodoId'), T('statusDoingId')], positions: [0, 1] }
  ],
  [
    'vault_create_journal_entry',
    'tool',
    W,
    { date: '2026-10-07', content_markdown: 'Shipped the pricing page.\n' }
  ],
  [
    'vault_update_journal_entry',
    'tool',
    W,
    {
      date: '2026-10-06',
      content_markdown: 'Planned the launch with the team.\n',
      tags: ['planning']
    }
  ],
  [
    'vault_add_to_inbox',
    'tool',
    W,
    {
      source: 'agent',
      title: 'Competitor pricing',
      content: 'Compare the three plans on the pricing pages.'
    }
  ],
  [
    'vault_update_inbox_item',
    'tool',
    W,
    { id: T('inboxId'), title: 'Call the printer about flyers' }
  ],
  [
    'vault_snooze_inbox_item',
    'tool',
    W,
    { id: T('inbox2Id'), snooze_until: '2026-10-12T09:00:00.000Z', reason: 'After the launch' }
  ],
  ['vault_archive_inbox_item', 'tool', W, { id: T('inbox3Id') }],
  ['vault_unarchive_inbox_item', 'tool', W, { id: T('inbox3Id') }],
  ['vault_add_inbox_tag', 'tool', W, { id: T('inboxId'), tag: 'errands' }],
  ['vault_remove_inbox_tag', 'tool', W, { id: T('inboxId'), tag: 'errands' }],
  ['vault_create_canvas', 'tool', W, { title: 'Retro board' }],
  [
    'vault_add_canvas_item',
    'tool',
    W,
    {
      canvas_id: T('canvasId'),
      items: [
        { entity_type: 'note', entity_id: T('noteId') },
        { entity_type: 'task', entity_id: T('taskId') }
      ]
    }
  ],
  [
    'vault_remove_canvas_item',
    'tool',
    W,
    { canvas_id: T('canvasId'), entity_type: 'task', entity_id: T('taskId') }
  ],
  [
    'vault_draw_on_canvas',
    'tool',
    W,
    {
      canvas_id: T('canvasId'),
      elements: [
        {
          ref: 'idea',
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          text: 'Idea',
          backgroundColor: '#fef3c7',
          fillStyle: 'solid'
        },
        { ref: 'ship', type: 'ellipse', x: 320, y: 0, width: 160, height: 80, text: 'Ship' },
        { type: 'arrow', start: { ref: 'idea' }, end: { ref: 'ship' } }
      ]
    }
  ],
  [
    'vault_edit_canvas_elements',
    'tool',
    W,
    {
      canvas_id: T('canvasId'),
      edits: [
        { elementId: T('drawnElementId'), backgroundColor: '#dcfce7', text: 'Idea (approved)' }
      ]
    }
  ],
  [
    'vault_desktop_write',
    'tool',
    W,
    { operation: 'notes.ensurePropertyDefinition', args: ['priority', 'select'] }
  ],

  // Desktop write operations
  [
    'notes.create',
    'op',
    W,
    [
      {
        title: 'Press kit',
        content: '# Press kit\n\nLogos and screenshots.\n',
        folder: 'Projects',
        tags: ['website']
      }
    ]
  ],
  [
    'notes.update',
    'op',
    W,
    [{ id: T('note2Id'), content: '# Launch checklist\n\n- [ ] DNS\n- [ ] Analytics\n' }]
  ],
  ['notes.rename', 'op', W, [T('renameNoteId'), 'Q4 roadmap (draft)']],
  ['notes.move', 'op', W, [T('moveNoteId'), 'Projects']],
  ['notes.createFolder', 'op', W, ['Projects/Assets']],
  ['notes.renameFolder', 'op', W, ['Projects/Assets', 'Projects/Brand assets']],
  [
    'notes.createPropertyDefinition',
    'op',
    W,
    [
      {
        name: 'effort',
        type: 'select',
        options: [
          { value: 'S', color: 'green' },
          { value: 'L', color: 'red' }
        ]
      }
    ]
  ],
  ['notes.updatePropertyDefinition', 'op', W, [{ name: 'effort', color: 'blue' }]],
  ['notes.ensurePropertyDefinition', 'op', W, ['stage', 'select']],
  ['notes.addPropertyOption', 'op', W, ['stage', { value: 'review', color: 'yellow' }]],
  [
    'notes.addStatusOption',
    'op',
    W,
    ['progress', 'in_progress', { value: 'waiting', color: 'orange' }]
  ],
  ['notes.renamePropertyOption', 'op', W, ['stage', 'review', 'in review']],
  ['notes.updateOptionColor', 'op', W, ['stage', 'in review', 'purple']],
  ['notes.removePropertyOption', 'op', W, ['stage', 'in review']],
  ['notes.uploadAttachment', 'op', W, [T('noteId'), { name: 'photo.png', arrayBuffer: null }]],
  ['notes.setFolderConfig', 'op', W, ['Projects', { icon: 'folder-kanban' }]],
  ['notes.restoreVersion', 'op', W, [T('snapshotId')]],
  [
    'notes.reorder',
    'op',
    W,
    ['Projects', ['Projects/Launch checklist.md', 'Projects/Website relaunch plan.md']]
  ],
  ['notes.importFiles', 'op', W, [[path.join(FILES, 'reading-list.md')], 'Projects']],
  ['notes.setLocalOnly', 'op', W, [T('meetingNoteId'), true]],
  ['notes.setCalendarPropertyVisibility', 'op', W, ['deadline', true]],
  [
    'notes.applyTemplate',
    'op',
    W,
    [{ noteId: T('meetingNoteId'), templateId: T('templateId'), mode: 'body' }]
  ],
  [
    'notes.exportPdf',
    'op',
    W,
    [{ noteId: T('noteId'), pageSize: 'A4', outputPath: path.join(exportDir, 'plan.pdf') }]
  ],
  [
    'notes.exportHtml',
    'op',
    W,
    [{ noteId: T('noteId'), outputPath: path.join(exportDir, 'plan.html') }]
  ],
  [
    'tasks.create',
    'op',
    W,
    [
      {
        projectId: T('projectId'),
        title: 'Order the launch cake',
        priority: 1,
        dueDate: '2026-10-21'
      }
    ]
  ],
  [
    'tasks.update',
    'op',
    W,
    [{ id: T('taskId'), title: 'Write homepage copy', description: 'Hero, features, pricing.' }]
  ],
  ['tasks.complete', 'op', W, [{ id: T('task2Id') }]],
  ['tasks.uncomplete', 'op', W, [T('task2Id')]],
  ['tasks.archive', 'op', W, [T('task3Id')]],
  ['tasks.unarchive', 'op', W, [T('task3Id')]],
  [
    'tasks.move',
    'op',
    W,
    [{ taskId: T('task3Id'), targetStatusId: T('statusTodoId'), position: 0 }]
  ],
  [
    'tasks.reorder',
    'op',
    W,
    [
      [T('taskId'), T('task2Id')],
      [0, 1]
    ]
  ],
  ['tasks.duplicate', 'op', W, [T('task2Id')]],
  ['tasks.convertToSubtask', 'op', W, [T('task4Id'), T('taskId')]],
  ['tasks.convertToTask', 'op', W, [T('task4Id')]],
  ['tasks.createProject', 'op', W, [{ name: 'Office move', color: '#f97316' }]],
  ['tasks.updateProject', 'op', W, [{ id: T('project3Id'), name: 'Website relaunch v2' }]],
  ['tasks.archiveProject', 'op', W, [T('project3Id')]],
  [
    'tasks.reorderProjects',
    'op',
    W,
    [
      [T('projectId'), T('project3Id')],
      [0, 1]
    ]
  ],
  [
    'tasks.linkProjectItem',
    'op',
    W,
    [{ projectId: T('projectId'), itemType: 'note', itemId: T('note2Id') }]
  ],
  [
    'tasks.setProjectLinkPinned',
    'op',
    W,
    [{ projectId: T('projectId'), itemId: T('note2Id'), pinned: true }]
  ],
  [
    'tasks.unlinkProjectItem',
    'op',
    W,
    [{ projectId: T('projectId'), itemType: 'note', itemId: T('note2Id') }]
  ],
  ['tasks.setProjectHomeNote', 'op', W, [{ projectId: T('projectId'), noteId: T('noteId') }]],
  [
    'tasks.captureUrlToProject',
    'op',
    W,
    [{ projectId: T('projectId'), url: 'https://example.com/' }]
  ],
  [
    'tasks.importFilesToProject',
    'op',
    W,
    [{ projectId: T('projectId'), sourcePaths: [path.join(FILES, 'brief.md')] }]
  ],
  [
    'tasks.createStatus',
    'op',
    W,
    [{ projectId: T('projectId'), name: 'Review', color: '#a855f7' }]
  ],
  ['tasks.updateStatus', 'op', W, [T('statusDoingId'), { name: 'In progress' }]],
  [
    'tasks.reorderStatuses',
    'op',
    W,
    [
      [T('statusDoingId'), T('statusTodoId')],
      [0, 1]
    ]
  ],
  ['tasks.bulkComplete', 'op', W, [[T('task5Id'), T('task6Id')]]],
  ['tasks.bulkMove', 'op', W, [[T('task5Id'), T('task6Id')], T('project3Id')]],
  ['tasks.bulkArchive', 'op', W, [[T('task5Id')]]],
  [
    'inbox.captureText',
    'op',
    W,
    [{ content: 'Ask Sam for the hero photo', title: 'Hero photo', tags: ['website'] }]
  ],
  ['inbox.captureLink', 'op', W, [{ url: 'https://example.com/', tags: ['reading'] }]],
  [
    'inbox.captureImage',
    'op',
    W,
    [{ data: byteObject(TINY_PNG), filename: 'whiteboard.png', mimeType: 'image/png' }]
  ],
  [
    'inbox.captureVoice',
    'op',
    W,
    [
      {
        data: byteObject(Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYEC', 'base64')),
        duration: 1,
        format: 'webm',
        transcribe: false
      }
    ]
  ],
  [
    'inbox.captureClip',
    'op',
    W,
    [
      {
        html: '<p>Launch on a Tuesday.</p>',
        text: 'Launch on a Tuesday.',
        sourceUrl: 'https://example.com/launch-tips',
        sourceTitle: 'Launch tips'
      }
    ]
  ],
  [
    'inbox.capturePdf',
    'op',
    W,
    [{ data: PDF.toString('base64'), filename: 'report.pdf', extractText: false }]
  ],
  ['inbox.update', 'op', W, [{ id: T('inboxId'), content: 'Call the printer about 500 flyers.' }]],
  ['inbox.markViewed', 'op', W, [T('inboxId')]],
  ['inbox.addTag', 'op', W, [T('inboxId'), 'errands']],
  ['inbox.removeTag', 'op', W, [T('inboxId'), 'errands']],
  ['inbox.snooze', 'op', W, [{ itemId: T('inbox4Id'), snoozeUntil: '2026-10-12T09:00:00.000Z' }]],
  ['inbox.unsnooze', 'op', W, [T('inbox4Id')]],
  [
    'inbox.trackSuggestion',
    'op',
    W,
    [
      {
        itemId: T('inboxId'),
        itemType: 'note',
        suggestedTo: 'Projects',
        actualTo: 'Projects',
        confidence: 0.8
      }
    ]
  ],
  ['inbox.linkToNote', 'op', W, [T('inbox4Id'), T('noteId'), ['website']]],
  [
    'inbox.file',
    'op',
    W,
    [{ itemId: T('inbox5Id'), destination: { type: 'folder', path: 'Projects' } }]
  ],
  ['inbox.undoFile', 'op', W, [T('inbox5Id')]],
  ['inbox.convertToNote', 'op', W, [T('inbox6Id')]],
  [
    'inbox.convertToTask',
    'op',
    W,
    [T('inbox7Id'), { projectId: T('projectId'), dueDate: '2026-10-14', priority: 2 }]
  ],
  [
    'inbox.convertToEvent',
    'op',
    W,
    [
      T('inbox8Id'),
      { startAt: '2026-10-14T13:00:00.000Z', endAt: '2026-10-14T14:00:00.000Z', location: 'Studio' }
    ]
  ],
  ['inbox.convertToReminder', 'op', W, [T('inbox9Id'), { remindAt: '2026-10-13T08:00:00.000Z' }]],
  ['inbox.archive', 'op', W, [T('inbox10Id')]],
  ['inbox.undoArchive', 'op', W, [T('inbox10Id')]],
  ['inbox.bulkTag', 'op', W, [{ itemIds: [T('inboxId'), T('inbox2Id')], tags: ['launch'] }]],
  [
    'inbox.bulkSnooze',
    'op',
    W,
    [{ itemIds: [T('inbox11Id')], snoozeUntil: '2026-10-12T09:00:00.000Z' }]
  ],
  [
    'inbox.bulkFile',
    'op',
    W,
    [{ itemIds: [T('inbox12Id')], destination: { type: 'folder', path: 'Projects' } }]
  ],
  ['inbox.bulkArchive', 'op', W, [{ itemIds: [T('inbox13Id')] }]],
  ['inbox.unarchive', 'op', W, [T('inbox13Id')]],
  ['inbox.fileAllStale', 'op', W, []],
  ['inbox.retryTranscription', 'op', W, [T('voiceInboxId')]],
  ['inbox.retryMetadata', 'op', W, [T('linkInboxId')]],
  ['inbox.setStaleThreshold', 'op', W, [14]],
  [
    'journal.createEntry',
    'op',
    W,
    [{ date: '2026-10-08', content: 'Launch day prep.\n', tags: ['launch'] }]
  ],
  [
    'journal.updateEntry',
    'op',
    W,
    [{ date: '2026-10-08', content: 'Launch day prep went well.\n' }]
  ],
  ['properties.set', 'op', W, [T('noteId'), { stage: 'draft', owner: 'Sam' }]],
  ['properties.rename', 'op', W, [T('noteId'), 'owner', 'lead']],
  [
    'templates.create',
    'op',
    W,
    [{ name: 'Retro', content: '## Went well\n\n## To change\n', tags: ['meeting'] }]
  ],
  [
    'templates.update',
    'op',
    W,
    [{ id: T('templateId'), description: 'Agenda, notes, action items.' }]
  ],
  ['templates.duplicate', 'op', W, [T('templateId'), 'Meeting (short)']],
  [
    'savedFilters.create',
    'op',
    W,
    [
      {
        name: 'Urgent website tasks',
        config: { filters: { priorities: ['urgent', 'high'], tags: ['website'] } }
      }
    ]
  ],
  ['savedFilters.update', 'op', W, [{ id: T('savedFilterId'), name: 'Due this week' }]],
  ['savedFilters.reorder', 'op', W, [[T('savedFilterId')], [0]]],
  ['bookmarks.create', 'op', W, [{ itemType: 'note', itemId: T('note2Id') }]],
  ['bookmarks.toggle', 'op', W, [{ itemType: 'note', itemId: T('meetingNoteId') }]],
  ['bookmarks.reorder', 'op', W, [[T('bookmarkId')]]],
  ['bookmarks.bulkCreate', 'op', W, [[{ itemType: 'task', itemId: T('taskId') }]]],
  ['tags.pinNoteToTag', 'op', W, [{ noteId: T('noteId'), tag: 'website' }]],
  ['tags.unpinNoteFromTag', 'op', W, [{ noteId: T('noteId'), tag: 'website' }]],
  ['tags.updateTagColor', 'op', W, [{ tag: 'website', color: 'blue' }]],
  ['tags.updateTagIcon', 'op', W, [{ tag: 'website', icon: 'globe' }]],
  ['tags.renameTag', 'op', W, [{ oldName: 'draft', newName: 'drafts' }]],
  ['tags.mergeTag', 'op', W, [{ source: 'drafts', target: 'planning' }]],
  ['tags.removeTagFromNote', 'op', W, [{ noteId: T('note2Id'), tag: 'website' }]],
  ['tags.createCategory', 'op', W, [{ name: 'Areas' }]],
  ['tags.renameCategory', 'op', W, [{ id: T('categoryId'), name: 'Work areas' }]],
  [
    'tags.reorder',
    'op',
    W,
    [{ tags: [{ tag: 'website', categoryId: T('categoryId'), sortOrder: 0 }] }]
  ],
  [
    'folderView.setConfig',
    'op',
    W,
    ['Projects', { properties: { stage: { displayName: 'Stage' } } }]
  ],
  [
    'folderView.setView',
    'op',
    W,
    [
      { kind: 'folder', path: 'Projects' },
      { name: 'By stage', type: 'table', columns: [{ id: 'title' }, { id: 'stage' }] }
    ]
  ],
  [
    'reminders.create',
    'op',
    W,
    [
      {
        targetType: 'note',
        targetId: T('note2Id'),
        remindAt: '2026-10-10T08:00:00.000Z',
        title: 'Check DNS'
      }
    ]
  ],
  ['reminders.update', 'op', W, [{ id: T('reminderId'), remindAt: '2026-10-11T08:00:00.000Z' }]],
  ['reminders.snooze', 'op', W, [{ id: T('reminderId'), snoozeUntil: '2026-10-12T08:00:00.000Z' }]],
  ['reminders.dismiss', 'op', W, [T('reminder2Id')]],
  ['reminders.bulkDismiss', 'op', W, [{ reminderIds: [T('reminder3Id')] }]],
  [
    'calendar.createEvent',
    'op',
    W,
    [
      {
        title: 'Launch party',
        startAt: '2026-10-22T17:00:00.000Z',
        endAt: '2026-10-22T20:00:00.000Z',
        location: 'Office'
      }
    ]
  ],
  ['calendar.updateEvent', 'op', W, [{ id: T('eventId'), location: 'Room 4' }]],
  ['settings.set', 'op', W, ['agent-api-example', 'off']],
  ['settings.setJournalSettings', 'op', W, [{ showSchedule: true }]],
  ['settings.setAISettings', 'op', W, [{ enabled: true }]],
  ['settings.setVoiceTranscriptionSettings', 'op', W, [{ memoNameMode: 'timestamp' }]],
  ['settings.setTabSettings', 'op', W, [{ tabCloseButton: 'hover' }]],
  ['settings.setNoteEditorSettings', 'op', W, [{ toolbarMode: 'floating' }]],
  ['settings.setGeneralSettings', 'op', W, [{ theme: 'system' }]],
  ['settings.setEditorSettings', 'op', W, [{ spellCheck: true }]],
  ['settings.setTaskSettings', 'op', W, [{ defaultSortOrder: 'dueDate' }]],
  ['settings.setKeyboardSettings', 'op', W, [{ overrides: {} }]],
  ['settings.resetKeyboardSettings', 'op', W, []],
  ['settings.setSyncSettings', 'op', W, [{ attachmentAutoDownload: true }]],
  ['settings.setBackupSettings', 'op', W, [{ frequencyHours: 24 }]],
  ['settings.setGraphSettings', 'op', W, [{ showLabels: true }]],
  ['settings.setCalendarSettings', 'op', W, [{ dayCellClickBehavior: 'journal' }]],
  ['settings.setFeaturesSettings', 'op', W, [{ graph: true }]],
  ['settings.setInboxSettings', 'op', W, [{ reviewReminderEnabled: false }]],
  [
    'search.addReason',
    'op',
    W,
    [
      {
        itemId: T('noteId'),
        itemType: 'note',
        itemTitle: 'Website relaunch plan',
        searchQuery: 'relaunch'
      }
    ]
  ],
  ['search.clearReasons', 'op', W, []],
  ['search.rebuildIndex', 'op', W, []],
  ['homePages.create', 'op', W, [{ name: 'Launch week', icon: 'rocket' }]],
  ['homePages.update', 'op', W, [{ id: T('homePageId'), name: 'Today' }]],
  ['homePages.reorder', 'op', W, [[T('homePageId')]]],
  ['vault.updateConfig', 'op', W, [{ excludePatterns: ['.git', 'node_modules', '.trash'] }]],
  ['vault.reindex', 'op', W, []],
  ['canvas.create', 'op', W, [{ title: 'Sitemap' }]],
  [
    'vault.switch',
    'op',
    W,
    ['/Users/me/Documents/Other vault'],
    'switching the open vault ends the agent session, so the example is not run.'
  ],
  [
    'vault.downloadRemote',
    'op',
    W,
    ['3f6c2a1e-8b4d-4c1a-9e2f-5d7a8b9c0d1e', '/Users/me/Documents'],
    'it needs a signed-in account with a vault on the sync server, so the example is not run.'
  ],

  // Deletes, last
  ['notes.deleteAttachment', 'op', W, [T('noteId'), T('attachmentName')]],
  ['notes.deleteVersion', 'op', W, [T('snapshotId')]],
  ['notes.deletePropertyDefinition', 'op', W, ['effort']],
  ['notes.deleteFolder', 'op', W, ['Projects/Brand assets']],
  ['notes.delete', 'op', W, [T('deleteNoteId')]],
  ['vault_delete_note', 'tool', W, { id: T('deleteNote2Id') }],
  ['tasks.delete', 'op', W, [T('deleteTaskId')]],
  ['vault_delete_task', 'tool', W, { id: T('deleteTask2Id') }],
  ['tasks.bulkDelete', 'op', W, [[T('task6Id')]]],
  ['tasks.deleteStatus', 'op', W, [T('statusSpareId')]],
  ['vault_delete_status', 'tool', W, { id: T('statusSpare2Id') }],
  ['tasks.deleteProject', 'op', W, [T('deleteProjectId')]],
  ['vault_delete_project', 'tool', W, { id: T('deleteProject2Id') }],
  ['inbox.deletePermanent', 'op', W, [T('inbox14Id')]],
  ['vault_delete_inbox_item', 'tool', W, { id: T('inbox15Id') }],
  ['journal.deleteEntry', 'op', W, ['2026-10-08']],
  ['vault_delete_journal_entry', 'tool', W, { date: '2026-10-07' }],
  ['templates.delete', 'op', W, [T('deleteTemplateId')]],
  ['savedFilters.delete', 'op', W, [T('savedFilterId')]],
  ['bookmarks.delete', 'op', W, [T('bookmarkId')]],
  ['bookmarks.bulkDelete', 'op', W, [[T('bookmark2Id')]]],
  ['tags.deleteTag', 'op', W, ['obsolete']],
  ['tags.deleteCategory', 'op', W, [{ id: T('categoryId') }]],
  ['folderView.deleteView', 'op', W, [{ kind: 'folder', path: 'Projects' }, 'By stage']],
  ['reminders.delete', 'op', W, [T('reminderId')]],
  ['calendar.deleteEvent', 'op', W, [T('event2Id')]],
  ['homePages.delete', 'op', W, [T('homePage2Id')]],
  ['canvas.delete', 'op', W, [T('deleteCanvasId')]]
]

// ---------------------------------------------------------------------------
// Seed the throwaway vault through the renderer
// ---------------------------------------------------------------------------

const browser = await chromium.connectOverCDP(
  `http://127.0.0.1:${process.env.MEMRY_AGENT_CDP_PORT ?? 9222}`
)
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => !p.url().startsWith('devtools'))
await page.waitForFunction(() => Boolean(window.api?.notes), null, { timeout: 30_000 })
await sleep(4000)
await page.evaluate(() => {
  localStorage.setItem('memry:onboarding:tour:v1', '1')
  localStorage.setItem('memry:onboarding:star:v1', 'done')
})
await page.keyboard.press('Escape').catch(() => {})

const seed = await page.evaluate(
  async ({ pngBase64, files }) => {
    const api = window.api
    const id = (r) =>
      r?.id ??
      r?.note?.id ??
      r?.project?.id ??
      r?.task?.id ??
      r?.item?.id ??
      r?.itemId ??
      r?.canvas?.id ??
      r?.entry?.id ??
      r?.status?.id ??
      r?.template?.id ??
      r?.filter?.id ??
      r?.bookmark?.id ??
      r?.reminder?.id ??
      r?.event?.id ??
      r?.homePage?.id ??
      r?.page?.id ??
      r?.category?.id ??
      r?.savedFilter?.id ??
      r?.data?.id ??
      null
    const ids = {}
    const log = {}
    const features = await api.settings.getFeaturesSettings()
    await api.settings.setFeaturesSettings({ ...features, spatialCanvas: true })
    for (const folder of ['Projects', 'Archive', 'Meetings'])
      await api.notes.createFolder(folder).catch(() => {})
    const note = async (key, input) => {
      const r = await api.notes.create(input)
      log[key] = r
      ids[key] = id(r)
    }
    await note('noteId', {
      title: 'Website relaunch plan',
      folder: 'Projects',
      tags: ['website', 'planning'],
      content:
        '# Website relaunch plan\n\n## Goals\n\n- Faster pages\n- Clearer pricing\n\nSee [[Launch checklist]].\n'
    })
    await note('note2Id', {
      title: 'Launch checklist',
      folder: 'Projects',
      tags: ['website', 'obsolete'],
      content: '# Launch checklist\n\n- [ ] DNS\n'
    })
    await note('meetingNoteId', {
      title: 'Kickoff meeting',
      folder: 'Meetings',
      tags: ['meeting'],
      content: 'Attendees: Sam, Ada.\n'
    })
    await note('renameNoteId', {
      title: 'Roadmap',
      folder: 'Projects',
      tags: ['draft'],
      content: 'Q4 themes.\n'
    })
    await note('moveNoteId', {
      title: 'Old pricing ideas',
      folder: 'Projects',
      content: 'Three tiers.\n'
    })
    await note('deleteNoteId', { title: 'Scratch', folder: 'Projects', content: 'temp\n' })
    await note('deleteNote2Id', { title: 'Scratch 2', folder: 'Projects', content: 'temp\n' })
    const body = '\n## Goals\n\n- Faster pages\n- Clearer pricing\n\nSee [[Launch checklist]].\n'
    const longDraft =
      'The relaunch replaces the old marketing site with a faster one, rewrites the pricing page and moves the blog to the new design.\n'
    await api.notes.update({
      id: ids.noteId,
      content: `# Website relaunch plan\n\n${longDraft}${body}`
    })
    await api.notes.update({
      id: ids.noteId,
      content: `# Website relaunch plan\n\nSecond draft.\n${body}`
    })
    await api.properties.set(ids.noteId, { stage: 'idea' }).catch((e) => (log.props = String(e)))
    await api.notes.ensurePropertyDefinition('stage', 'select').catch(() => {})
    await api.notes.ensurePropertyDefinition('progress', 'status').catch(() => {})
    await api.notes.createPropertyDefinition({ name: 'deadline', type: 'date' }).catch(() => {})
    const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0))
    log.attachment = await api.notes
      .uploadAttachment(ids.noteId, new File([bytes], 'diagram.png', { type: 'image/png' }))
      .catch((e) => String(e))
    ids.attachmentName = log.attachment?.name
      ? String(log.attachment.path ?? '')
          .split('/')
          .pop()
      : null
    log.imported = await api.notes.importFiles([files.pdf], 'Projects').catch((e) => String(e))
    for (let i = 0; i < 20 && !ids.fileId; i++) {
      const listed = await api.notes.list({ folder: 'Projects' }).catch(() => null)
      ids.fileId = (listed?.notes ?? []).find((n) => n.path === 'Projects/report.pdf')?.id ?? null
      if (!ids.fileId) await new Promise((r) => setTimeout(r, 500))
    }
    await api.notes.setFolderConfig('Projects', { icon: 'folder' }).catch(() => {})
    await api.settings.set('agent-api-example', 'on').catch(() => {})
    const versions = await api.notes.getVersions(ids.noteId).catch(() => [])
    log.versions = versions
    const versionList = Array.isArray(versions)
      ? versions
      : (versions?.versions ?? versions?.snapshots ?? [])
    ids.snapshotId = versionList[versionList.length - 1]?.id ?? null

    const project = async (key, input) => {
      const r = await api.tasks.createProject(input)
      log[key] = r
      ids[key] = id(r)
    }
    await project('projectId', { name: 'Website relaunch', color: '#6366f1' })
    await project('project2Id', { name: 'Autumn hiring' })
    await project('project3Id', { name: 'Brand refresh' })
    await project('deleteProjectId', { name: 'Old intranet' })
    await project('deleteProject2Id', { name: 'Old blog' })
    const statuses = await api.tasks.listStatuses(ids.projectId)
    const list = Array.isArray(statuses) ? statuses : (statuses?.statuses ?? [])
    log.statuses = list
    ids.statusTodoId = list[0]?.id
    ids.statusDoingId = list[1]?.id ?? list[0]?.id
    for (const key of ['statusSpareId', 'statusSpare2Id']) {
      const r = await api.tasks.createStatus({
        projectId: ids.projectId,
        name: key === 'statusSpareId' ? 'Parked' : 'Someday'
      })
      log[key] = r
      ids[key] = id(r)
    }
    const task = async (key, input) => {
      const r = await api.tasks.create({ projectId: ids.projectId, ...input })
      log[key] = r
      ids[key] = id(r)
    }
    await task('taskId', {
      title: 'Write landing page copy',
      priority: 2,
      dueDate: '2026-10-09',
      tags: ['website']
    })
    await task('task2Id', { title: 'Review the new design', dueDate: '2026-10-07' })
    await task('task3Id', { title: 'Update the footer links' })
    await task('task4Id', { title: 'Check the meta descriptions' })
    await task('task5Id', { title: 'Compress hero images' })
    await task('task6Id', { title: 'Remove old tracking script' })
    await task('deleteTaskId', { title: 'Duplicate entry' })
    await task('deleteTask2Id', { title: 'Another duplicate' })
    await api.tasks.create({
      projectId: ids.projectId,
      title: 'Draft the hero headline',
      parentId: ids.taskId
    })
    await api.tasks
      .linkProjectItem({ projectId: ids.projectId, itemType: 'note', itemId: ids.noteId })
      .catch(() => {})

    for (let i = 1; i <= 15; i++) {
      const key = i === 1 ? 'inboxId' : `inbox${i}Id`
      const r = await api.inbox.captureText({
        content: i === 1 ? 'Call the printer about flyers' : `Idea ${i}: follow up on the launch`,
        title: i === 1 ? 'Printer' : `Idea ${i}`
      })
      log[key] = r
      ids[key] = id(r)
    }
    await api.inbox.archive(ids.inbox14Id).catch(() => {})
    const link = await api.inbox
      .captureLink({ url: 'https://example.com/pricing' })
      .catch((e) => String(e))
    log.linkInboxId = link
    ids.linkInboxId = id(link)
    const voice = await api.inbox
      .captureVoice({
        data: new Uint8Array([26, 69, 223, 163]),
        duration: 1,
        format: 'webm',
        transcribe: false
      })
      .catch((e) => String(e))
    log.voiceInboxId = voice
    ids.voiceInboxId = id(voice)

    await api.journal
      .createEntry({
        date: '2026-10-05',
        content: 'Kicked off the relaunch.\n',
        tags: ['planning']
      })
      .catch(() => {})
    await api.journal
      .createEntry({ date: '2026-10-06', content: 'Reviewed designs.\n' })
      .catch(() => {})

    const template = await api.templates.create({
      name: 'Meeting',
      content: '## Agenda\n\n## Notes\n\n## Action items\n'
    })
    log.template = template
    ids.templateId = id(template)
    ids.deleteTemplateId = id(
      await api.templates.create({ name: 'Unused template', content: 'x\n' })
    )
    const filter = await api.savedFilters.create({
      name: 'Due soon',
      config: { filters: { completion: 'active' } }
    })
    log.filter = filter
    ids.savedFilterId = id(filter)
    const bookmark = await api.bookmarks.create({ itemType: 'note', itemId: ids.noteId })
    log.bookmark = bookmark
    ids.bookmarkId = id(bookmark)
    ids.bookmark2Id = id(await api.bookmarks.create({ itemType: 'project', itemId: ids.projectId }))
    const category = await api.tags.createCategory({ name: 'Work' })
    log.category = category
    ids.categoryId = id(category)
    const reminder = async (key, title) => {
      const r = await api.reminders.create({
        targetType: 'note',
        targetId: ids.noteId,
        remindAt: '2026-10-09T08:00:00.000Z',
        title
      })
      log[key] = r
      ids[key] = id(r)
    }
    await reminder('reminderId', 'Review the plan')
    await reminder('reminder2Id', 'Send the plan')
    await reminder('reminder3Id', 'Share the plan')
    const event = async (key, title, day) => {
      const r = await api.calendar.createEvent({
        title,
        startAt: `2026-10-${day}T10:00:00.000Z`,
        endAt: `2026-10-${day}T11:00:00.000Z`
      })
      log[key] = r
      ids[key] = id(r)
    }
    await event('eventId', 'Design review', '08')
    await event('event2Id', 'Old standup', '09')
    const home = async (key, name) => {
      const r = await api.homePages.create({ name })
      log[key] = r
      ids[key] = id(r)
    }
    await home('homePageId', 'Focus')
    await home('homePage2Id', 'Spare')
    const canvas = async (key, title) => {
      const r = await api.canvas.create({ title })
      log[key] = r
      ids[key] = id(r)
    }
    await canvas('canvasId', 'Launch board')
    await canvas('deleteCanvasId', 'Scratch board')
    return { ids, log }
  },
  { pngBase64: PNG.toString('base64'), files: { pdf: path.join(FILES, 'report.pdf') } }
)
const ids = seed.ids
fs.writeFileSync(
  path.join(os.tmpdir(), 'agent-api-capture-seed.json'),
  JSON.stringify(seed, null, 2)
)
const missing = Object.entries(ids)
  .filter(([, value]) => !value)
  .map(([key]) => key)
if (missing.length > 0) console.warn(`Seed left these ids empty: ${missing.join(', ')}`)

// ---------------------------------------------------------------------------
// A turn that holds its write grant open
// ---------------------------------------------------------------------------

mainEval(`(() => { const http = process.mainModule.require('http'); const g = globalThis.__agentApiGrants = globalThis.__agentApiGrants ?? []
  for (const h of process._getActiveHandles()) if (h instanceof http.Server && !h.__agentApi) { h.__agentApi = true; h.prependListener('request', (req) => { const t = req.headers['x-memry-turn']; if (t && !g.includes(t)) g.push(t) }) }
  return g.length })()`)

let release = null
const released = new Promise((resolve) => (release = resolve))
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'fake', object: 'chat.completion.chunk', created: 0, model: 'fake-local', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'fake-local' }] }))
  }
  let raw = ''
  for await (const part of req) raw += part
  const body = raw ? JSON.parse(raw) : {}
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' })
    const call = {
      id: 'probe-1',
      type: 'function',
      function: { name: 'memry_probe_echo', arguments: '{"text":"ok"}' }
    }
    return res.end(
      JSON.stringify({
        choices: [
          {
            message: Array.isArray(body.tools)
              ? { role: 'assistant', content: null, tool_calls: [call] }
              : { role: 'assistant', content: 'ok' }
          }
        ]
      })
    )
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const toolNames = (body.tools ?? []).map((tool) => tool.function?.name)
  const answered = (body.messages ?? []).some((message) => message.role === 'tool')
  if (toolNames.length === 0)
    return res.end(`${chunk({ content: 'ok' })}${chunk({}, 'stop')}data: [DONE]\n\n`)
  if (!answered) {
    const args = JSON.stringify({ operation: 'notes.getTags', args: [] })
    return res.end(
      `${chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'vault_desktop_read', arguments: args } }] })}${chunk({}, 'tool_calls')}data: [DONE]\n\n`
    )
  }
  await released
  res.end(`${chunk({ content: 'Examples captured.' })}${chunk({}, 'stop')}data: [DONE]\n\n`)
})
await new Promise((resolve) => fake.listen(18461, '127.0.0.1', resolve))

await page.evaluate(() => window.api.agent.setPreferences({ toolApprovalMode: 'always_accept' }))
await page.evaluate(() =>
  window.api.agent.setLocalProviderSettings({
    preset: 'custom',
    baseUrl: 'http://127.0.0.1:18461/v1',
    model: 'fake-local',
    allowNonLoopback: false
  })
)
const inner = page.locator('[data-slot="day-panel-inner"]')
if (!(await inner.isVisible().catch(() => false)))
  await page
    .getByRole('button', { name: 'Day Panel', exact: true })
    .click()
    .catch(() => {})
const region = page.getByRole('region', { name: 'Agent chat' })
for (let i = 0; i < 60 && !(await region.isVisible().catch(() => false)); i++) {
  const enable = page.getByRole('button', { name: 'Enable Agent chat' })
  if (await enable.isVisible().catch(() => false))
    await enable.click({ timeout: 2000 }).catch(() => {})
  else
    await page
      .getByRole('tab', { name: 'Agent', exact: true })
      .click({ timeout: 1000 })
      .catch(() => {})
  await sleep(500)
}
await page.getByTestId('agent-model-trigger').click()
await page.getByTestId('agent-model-submenu-trigger').click()
await page.getByRole('textbox', { name: /search models/i }).fill('fake-local')
await sleep(1500)
const items = page.getByRole('menuitem')
const index = (await items.allInnerTexts()).findIndex((text) => text.trim() === 'fake-local')
if (index < 0) throw new Error('The fake-local model is not listed')
await items.nth(index).click()
await sleep(500)

mainEval(`(() => { const http = process.mainModule.require('http'); const g = globalThis.__agentApiGrants
  for (const h of process._getActiveHandles()) if (h instanceof http.Server && !h.__agentApi) { h.__agentApi = true; h.prependListener('request', (req) => { const t = req.headers['x-memry-turn']; if (t && !g.includes(t)) g.push(t) }) }
  return g.length })()`)
await page.getByTestId('agent-composer-input').fill('Capture the agent API examples.')
await page.getByTestId('agent-composer-input').press('Enter')
let grant = null
for (let i = 0; i < 120 && !grant; i++) {
  await sleep(500)
  grant = JSON.parse(mainEval('JSON.stringify(globalThis.__agentApiGrants)')).at(-1) ?? null
}
if (!grant) throw new Error('No turn grant seen')

// ---------------------------------------------------------------------------
// MCP JSON-RPC client
// ---------------------------------------------------------------------------

const status = await page.evaluate(() => window.api.agentMcp.getStatus())
const windowId = mainEval(
  "process.mainModule.require('electron').BrowserWindow.getAllWindows().map((w) => w.id)[0]"
)
let rid = 1
async function rpc(method, params, withGrant) {
  const headers = {
    authorization: `Bearer ${status.token}`,
    'x-memry-window': String(windowId),
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(withGrant ? { 'x-memry-turn': grant } : {})
  }
  const res = await fetch(`${status.url}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method, params })
  })
  const text = await res.text()
  const line = text.split('\n').find((l) => l.startsWith('data: '))
  return JSON.parse(line ? line.slice(6) : text)
}
await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'agent-api-capture', version: '1' }
})
const toolsList = (await rpc('tools/list', {})).result.tools
fs.writeFileSync(
  path.join(os.tmpdir(), 'agent-api-tools-list.json'),
  JSON.stringify(toolsList, null, 1)
)

// ---------------------------------------------------------------------------
// Tokens, trimming
// ---------------------------------------------------------------------------

const tokenOf = new Map()
for (const [key, value] of Object.entries(ids)) if (value) tokenOf.set(value, T(key))
const valueOf = new Map([...tokenOf].map(([value, token]) => [token, value]))
const realVault = fs.realpathSync(vault)

const fill = (value) => {
  if (typeof value === 'string') return valueOf.get(value) ?? value
  if (Array.isArray(value)) return value.map(fill)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
  return value
}
const tokenize = (value) => {
  if (typeof value === 'string') {
    let out = tokenOf.get(value) ?? value
    for (const [real, token] of tokenOf)
      if (real.length >= 12 && out.includes(real)) out = out.split(real).join(token)
    for (const dir of [realVault, vault]) out = out.split(dir).join('<vault>')
    out = out.split(FILES).join('/Users/me/Downloads')
    return out
  }
  if (Array.isArray(value)) return value.map(tokenize)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [tokenize(k), tokenize(v)]))
  return value
}
const trim = (value, depth = 0) => {
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => trim(v, depth + 1))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v, depth + 1)]))
  return value
}
const replyOf = (raw) => {
  const out = raw.result ?? raw.error
  const parts = out?.content ?? []
  const text = parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text || out
  }
  if (parts.some((p) => p.type === 'image')) {
    const image = parts.find((p) => p.type === 'image')
    json = {
      json,
      image: {
        type: 'image',
        mimeType: image.mimeType,
        data: `<${Math.round((image.data?.length ?? 0) * 0.75)} bytes of base64>`
      }
    }
  }
  return { reply: json, isError: Boolean(out?.isError || raw.error) }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const results = { tools: {}, operations: {} }
const report = []
const live = {}
for (const [key, kind, rw, call, notRun] of CALLS) {
  if (key === 'vault_edit_canvas_elements') {
    const drawn = live.vault_draw_on_canvas?.reply
    const elementId = drawn?.created?.[0] ?? drawn?.refs?.idea ?? drawn?.element_ids?.[0]
    if (elementId)
      (valueOf.set(T('drawnElementId'), elementId), tokenOf.set(elementId, T('drawnElementId')))
  }
  const entry = kind === 'tool' ? { arguments: tokenize(call) } : { args: tokenize(call) }
  if (notRun) {
    entry.not_run = notRun
  } else {
    const params =
      kind === 'tool'
        ? { name: key, arguments: fill(call) }
        : {
            name: rw === W ? 'vault_desktop_write' : 'vault_desktop_read',
            arguments: { operation: key, args: fill(call) }
          }
    const raw = await rpc('tools/call', params, rw === W)
    const { reply, isError } = replyOf(raw)
    live[key] = { reply, isError }
    entry.reply = trim(tokenize(reply))
    if (isError) entry.is_error = true
    report.push({ key, isError, reply: JSON.stringify(entry.reply).slice(0, 400) })
    console.log(`${isError ? 'ERR' : 'ok '} ${key}`)
  }
  ;(kind === 'tool' ? results.tools : results.operations)[key] = entry
}
release()
await sleep(1500)
fake.close()
await browser.close()

fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
if (VERIFY) {
  const committed = JSON.parse(fs.readFileSync(EXAMPLES, 'utf8'))
  const shape = (value) =>
    Array.isArray(value)
      ? value.length === 0
        ? '[]'
        : `[${shape(value[0])}]`
      : value && typeof value === 'object'
        ? `{${Object.keys(value)
            .sort()
            .map((k) => `${k}:${shape(value[k])}`)
            .join(',')}}`
        : value === null
          ? 'null'
          : typeof value
  const diffs = []
  for (const group of ['tools', 'operations']) {
    for (const [key, entry] of Object.entries(committed[group])) {
      const now = results[group][key]
      if (!now) diffs.push({ key, problem: 'not run' })
      else if (Boolean(entry.is_error) !== Boolean(now.is_error))
        diffs.push({ key, problem: 'error state differs', committed: entry.reply, now: now.reply })
      else if (shape(entry.reply) !== shape(now.reply))
        diffs.push({
          key,
          problem: 'reply shape differs',
          committed: shape(entry.reply),
          now: shape(now.reply)
        })
    }
  }
  fs.writeFileSync(REPORT.replace(/\.json$/, '-verify.json'), JSON.stringify(diffs, null, 2))
  console.log(`${diffs.length} examples differ from the committed replies.`)
  process.exit(diffs.length === 0 ? 0 : 1)
}
fs.writeFileSync(EXAMPLES, `${JSON.stringify(results, null, 2)}\n`)
console.log(`Wrote ${EXAMPLES}`)
