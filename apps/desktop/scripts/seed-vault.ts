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
import matter from 'gray-matter'

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
  insertTagCategories,
  insertTagDefinitions,
  insertTaskNotes,
  insertTasks,
  insertTaskTags,
  openDataDb
} from './seed-vault/db-writer'
import { generateId } from '../src/main/lib/id'
import {
  allocateCanvasPath,
  resolveCanvasFile,
  withCanvasMeta,
  writeCanvasFileSync
} from '../src/main/canvas/scene-file'

import { FOLDER_CONFIGS, NOTES, NOTE_METADATA } from './seed-data/notes'
import { JOURNAL_NOTES, JOURNAL_METADATA } from './seed-data/journal'
import { PROJECTS, STATUSES, TASKS, TASK_NOTES, TASK_TAGS } from './seed-data/tasks'
import { PROJECT_LINKS } from './seed-data/project-links'
import { CALENDAR_EVENTS, CALENDAR_SOURCES } from './seed-data/calendar'
import { FILING_HISTORY_ROWS, INBOX_ITEMS } from './seed-data/inbox'
import { HOME_BOOKMARKS, HOME_PAGES } from './seed-data/home'
import { CANVASES } from './seed-data/canvas'
import { buildPropertiesFileData, PROPERTY_DEFINITION_ROWS } from './seed-data/properties'
import { TAG_CATEGORIES, TAG_PALETTE } from './seed-data/tags'

interface CliArgs {
  vaultPath: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {}
  for (const raw of argv) {
    if (raw.startsWith('--vault=')) {
      args.vaultPath = resolve(raw.slice('--vault='.length))
    }
    if (raw.startsWith('--device=')) {
      // Accepted and ignored: canvases used to be encrypted under a per-device
      // keychain key, so a seeded vault only opened in the matching dev profile.
      // They are files now — every profile can read them.
      console.warn('--device is no longer needed; canvases are plain files in the vault.')
    }
  }
  return {
    vaultPath: args.vaultPath ?? resolve(homedir(), 'MemryDemoVault')
  }
}

/**
 * `.memry/properties.md` — the source of truth PropertyDefinitionsService reads
 * on vault open. Without it the seeded `property_definitions` rows are dropped
 * the first time the vault is opened and every note property falls back to
 * inferred text.
 */
function writePropertyDefinitionsFile(vaultPath: string): void {
  const propertiesPath = resolve(vaultPath, '.memry', 'properties.md')
  writeFileSync(propertiesPath, matter.stringify('', { properties: buildPropertiesFileData() }), {
    encoding: 'utf8'
  })
}

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
  const { vaultPath } = parseArgs(process.argv.slice(2))

  console.log(`Seeding demo vault at: ${vaultPath}`)

  console.log('  → Wiping existing contents...')
  wipeVault(vaultPath)

  console.log('  → Writing .memry/config.json')
  writeMinimalConfig(vaultPath)

  console.log('  → Writing .memry/properties.md')
  writePropertyDefinitionsFile(vaultPath)

  const dataDbPath = resolve(vaultPath, '.memry', 'data.db')
  console.log(`  → Opening + migrating data.db at ${dataDbPath}`)
  const { db, close } = openDataDb(dataDbPath)

  try {
    const tagCategoryCount = insertTagCategories(db, TAG_CATEGORIES)
    console.log(`  → tag_categories: ${tagCategoryCount}`)

    const tagCount = insertTagDefinitions(db, TAG_PALETTE)
    console.log(`  → tag_definitions: ${tagCount}`)

    const folderCount = insertFolderConfigs(db, FOLDER_CONFIGS)
    console.log(`  → folder_configs: ${folderCount}`)

    const propCount = insertPropertyDefinitions(db, PROPERTY_DEFINITION_ROWS)
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

    // Canvases are plain `.excalidraw` files in the vault, written through the
    // app's own writer so the seed can never drift from the real format. No key
    // material, no keychain, no device binding: a seeded vault opens in any
    // profile and survives being copied elsewhere.
    const vaultId = ensureVaultMetadata(db)
    const claimed = new Set<string>()
    const canvasCount = insertCanvases(
      db,
      vaultId,
      CANVASES.map((c) => {
        const filePath = allocateCanvasPath(vaultPath, c.title, claimed)
        claimed.add(filePath)
        const now = Date.now()
        writeCanvasFileSync(
          resolveCanvasFile(vaultPath, filePath),
          withCanvasMeta(c.scene, { id: c.id, createdAt: now, updatedAt: now })
        )
        return { id: c.id, title: c.title, filePath, entityRefs: c.entityRefs }
      })
    )
    console.log(`  → canvases: ${canvasCount} (as .excalidraw files in canvases/)`)
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
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
