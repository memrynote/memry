#!/usr/bin/env npx tsx
/**
 * Unified seed command — populates a dedicated demo vault with notes, tasks,
 * calendar, journal, and inbox content for screenshots and exploration.
 *
 * Default target: ~/MemryDemoVault. Override with --vault=<path>.
 * Always wipes and re-seeds.
 */

import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { homedir } from 'os'

import { wipeVault } from './seed-vault/wipe'
import { writeNoteFiles } from './seed-vault/file-writer'
import {
  ensureVaultMetadata,
  insertBookmarks,
  insertCalendarEvents,
  insertCalendarSources,
  insertCanvases,
  insertFilingHistory,
  insertFolderConfigs,
  insertHomePages,
  insertInboxItems,
  insertProjects,
  insertProjectLinks,
  insertNoteMetadata,
  insertPropertyDefinitions,
  insertStatuses,
  insertTagDefinitions,
  insertTaskNotes,
  insertTasks,
  insertTaskTags,
  openDataDb,
  upsertSetting
} from './seed-vault/db-writer'
import {
  computeVaultKeyVerifier,
  encryptCanvasScene,
  resolveVaultKey,
  VAULT_KEY_VERIFIER_SETTING
} from './seed-vault/canvas-crypto'

import { FOLDER_CONFIGS, NOTES, NOTE_METADATA } from './seed-data/notes'
import { JOURNAL_NOTES, JOURNAL_METADATA } from './seed-data/journal'
import { PROJECTS, STATUSES, TASKS, TASK_NOTES, TASK_TAGS } from './seed-data/tasks'
import { PROJECT_LINKS } from './seed-data/project-links'
import { CALENDAR_EVENTS, CALENDAR_SOURCES } from './seed-data/calendar'
import { FILING_HISTORY_ROWS, INBOX_ITEMS } from './seed-data/inbox'
import { HOME_BOOKMARKS, HOME_PAGES } from './seed-data/home'
import { CANVASES } from './seed-data/canvas'

interface CliArgs {
  vaultPath: string
  /**
   * Keychain device suffix used to derive the canvas encryption key. Must match
   * the app instance that will open the vault: 'dev' for plain `pnpm dev`
   * (default), 'A'/'B'/'C' for the dev:a/b/c profiles.
   */
  device: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {}
  for (const raw of argv) {
    if (raw.startsWith('--vault=')) {
      args.vaultPath = resolve(raw.slice('--vault='.length))
    }
    if (raw.startsWith('--device=')) {
      args.device = raw.slice('--device='.length)
    }
  }
  return {
    vaultPath: args.vaultPath ?? resolve(homedir(), 'MemryDemoVault'),
    device: args.device || 'dev'
  }
}

const TAG_PALETTE = [
  { name: 'research', color: '#3b82f6' },
  { name: 'active', color: '#10b981' },
  { name: 'archive', color: '#6b7280' },
  { name: 'sci-fi', color: '#8b5cf6' },
  { name: 'fiction', color: '#f59e0b' },
  { name: 'nonfiction', color: '#ec4899' },
  { name: 'classic', color: '#a855f7' },
  { name: 'reread', color: '#0ea5e9' },
  { name: 'tech/typescript', color: '#0ea5e9' },
  { name: 'tech/sql', color: '#a855f7' },
  { name: 'tech/sync', color: '#22c55e' },
  { name: 'tech/rust', color: '#dc2626' },
  { name: 'tech/electron', color: '#9333ea' },
  { name: 'tech/postgres', color: '#0284c7' },
  { name: 'tech/python', color: '#22c55e' },
  { name: 'projects/memry', color: '#6366f1' },
  { name: 'projects/active', color: '#14b8a6' },
  { name: 'projects/personal', color: '#f97316' },
  { name: 'projects/home', color: '#84cc16' },
  { name: 'travel/asia', color: '#f97316' },
  { name: 'travel/europe', color: '#0ea5e9' },
  { name: 'travel/japan', color: '#ef4444' },
  { name: 'food', color: '#e11d48' },
  { name: 'city-break', color: '#22c55e' },
  { name: 'favorites', color: '#f59e0b' },
  { name: 'fitness', color: '#84cc16' },
  { name: 'reading', color: '#f59e0b' },
  { name: 'daily', color: '#6366f1' },
  { name: 'flow', color: '#10b981' },
  { name: 'reflection', color: '#a855f7' }
]

const PROPERTY_DEFS = [
  { name: 'rating', type: 'number', color: '#f59e0b' },
  { name: 'status', type: 'text', color: '#6366f1' },
  { name: 'priority', type: 'text', color: '#ef4444' },
  { name: 'mood', type: 'number', color: '#a855f7' },
  { name: 'weight', type: 'number', color: '#84cc16' },
  { name: 'bodyFat', type: 'number', color: '#84cc16' },
  { name: 'author', type: 'text', color: '#0ea5e9' },
  { name: 'director', type: 'text', color: '#ec4899' },
  { name: 'genre', type: 'text', color: '#8b5cf6' },
  { name: 'language', type: 'text', color: '#10b981' },
  { name: 'level', type: 'text', color: '#6b7280' },
  { name: 'location', type: 'text', color: '#f97316' },
  { name: 'year', type: 'number', color: '#6366f1' },
  { name: 'pages', type: 'number', color: '#f59e0b' },
  { name: 'deadline', type: 'date', color: '#ef4444' },
  { name: 'startDate', type: 'date', color: '#10b981' },
  { name: 'endDate', type: 'date', color: '#10b981' },
  { name: 'owner', type: 'text', color: '#6b7280' }
]

function writeMinimalConfig(vaultPath: string): void {
  const configPath = resolve(vaultPath, '.memry', 'config.json')
  try {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: 1,
          title: 'memrynote Demo Vault',
          excludePatterns: ['.git', 'node_modules', '.DS_Store']
        },
        null,
        2
      ),
      { encoding: 'utf8', flag: 'wx' }
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
  }
}

async function main(): Promise<void> {
  const { vaultPath, device } = parseArgs(process.argv.slice(2))

  console.log(`Seeding demo vault at: ${vaultPath}`)

  console.log('  → Wiping existing contents...')
  wipeVault(vaultPath)

  console.log('  → Writing .memry/config.json')
  writeMinimalConfig(vaultPath)

  const dataDbPath = resolve(vaultPath, '.memry', 'data.db')
  console.log(`  → Opening + migrating data.db at ${dataDbPath}`)
  const { db, close } = openDataDb(dataDbPath)

  try {
    const tagCount = insertTagDefinitions(db, TAG_PALETTE)
    console.log(`  → tag_definitions: ${tagCount}`)

    const folderCount = insertFolderConfigs(db, FOLDER_CONFIGS)
    console.log(`  → folder_configs: ${folderCount}`)

    const propCount = insertPropertyDefinitions(db, PROPERTY_DEFS)
    console.log(`  → property_definitions: ${propCount}`)

    // Files carry no Memry ids — canonical rows keep seeded ids stable
    // (task links reference NOTE_IDS) when the indexer adopts them by path
    const noteMetaCount = insertNoteMetadata(db, [...NOTE_METADATA, ...JOURNAL_METADATA])
    console.log(`  → note_metadata: ${noteMetaCount}`)

    const projectCount = insertProjects(db, PROJECTS)
    console.log(`  → projects: ${projectCount}`)

    const statusCount = insertStatuses(db, STATUSES)
    console.log(`  → statuses: ${statusCount}`)

    const taskCount = insertTasks(db, TASKS)
    console.log(`  → tasks: ${taskCount}`)

    const taskNoteCount = insertTaskNotes(db, TASK_NOTES)
    console.log(`  → task_notes: ${taskNoteCount}`)

    const taskTagCount = insertTaskTags(db, TASK_TAGS)
    console.log(`  → task_tags: ${taskTagCount}`)

    const calendarSourceCount = insertCalendarSources(db, CALENDAR_SOURCES)
    console.log(`  → calendar_sources: ${calendarSourceCount}`)

    const calendarEventCount = insertCalendarEvents(db, CALENDAR_EVENTS)
    console.log(`  → calendar_events: ${calendarEventCount}`)

    // Project Home links — notes + events. Rows carry no FK to their target,
    // so they must be seeded after the notes/events they point at.
    const projectLinkCount = insertProjectLinks(db, PROJECT_LINKS)
    console.log(`  → project_links: ${projectLinkCount}`)

    const inboxCount = insertInboxItems(db, INBOX_ITEMS)
    console.log(`  → inbox_items: ${inboxCount}`)

    const filingCount = insertFilingHistory(db, FILING_HISTORY_ROWS)
    console.log(`  → filing_history: ${filingCount}`)

    const bookmarkCount = insertBookmarks(db, HOME_BOOKMARKS)
    console.log(`  → bookmarks: ${bookmarkCount}`)

    const homePageCount = insertHomePages(db, HOME_PAGES)
    console.log(`  → home_pages: ${homePageCount}`)

    // Canvas scenes are encrypted at rest with the vault key; derive the same
    // key the app will use and pre-bind the vault to it via the verifier.
    const vaultId = ensureVaultMetadata(db)
    const vaultKey = await resolveVaultKey(device)
    upsertSetting(db, VAULT_KEY_VERIFIER_SETTING, computeVaultKeyVerifier(vaultKey, vaultId))
    const canvasCount = insertCanvases(
      db,
      vaultId,
      CANVASES.map((c) => ({
        id: c.id,
        title: c.title,
        snapshotCiphertext: encryptCanvasScene(c.scene, vaultKey),
        entityRefs: c.entityRefs
      }))
    )
    console.log(`  → canvases: ${canvasCount} (scenes encrypted for device '${device}')`)
  } finally {
    close()
  }

  console.log(`  → Writing ${NOTES.length} note files`)
  const notesWritten = writeNoteFiles(vaultPath, NOTES)

  console.log(`  → Writing ${JOURNAL_NOTES.length} journal files`)
  const journalsWritten = writeNoteFiles(vaultPath, JOURNAL_NOTES)

  console.log('')
  console.log('Done.')
  console.log(
    `Seeded ${notesWritten} notes, ${journalsWritten} journal entries, ${TASKS.length} tasks, ${CALENDAR_EVENTS.length} events, ${PROJECT_LINKS.length} project links, ${INBOX_ITEMS.length} inbox items, ${HOME_PAGES.length} home board with ${HOME_PAGES[0].widgets.length} widgets, ${CANVASES.length} canvases.`
  )
  console.log(`Vault path: ${vaultPath}`)
  console.log('')
  console.log('Open memrynote → Switch Vault → choose this path to view.')
  console.log(
    `Note: canvas scenes are bound to the '${device}' dev keychain device — open the vault with the matching app profile (--device=A|B|C to target dev:a/b/c).`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
