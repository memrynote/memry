/**
 * Integration test for the NotePlan importer orchestrator.
 * Runs against a fixture export and a real temp vault + databases; the task
 * side is driven through injected fakes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { createTestVault, type TestVaultResult } from '@tests/utils/test-vault'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VaultStatus, VaultConfig } from '@memry/contracts/vault-api'
import { startProjectionRuntime, stopProjectionRuntime } from '../../projections'
import { createNoteDerivedStateProjector } from '../../projections/projectors/note-derived-state-projector'
import type { NotePlanTaskDeps } from './noteplan-importer'

vi.mock('electron', () => {
  const send = vi.fn()
  return {
    BrowserWindow: {
      getAllWindows: vi.fn(() => [{ isDestroyed: () => false, webContents: { send } }])
    },
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() }
  }
})

vi.mock('../../inbox/suggestions', () => ({
  updateNoteEmbedding: vi.fn(() => Promise.resolve())
}))

vi.mock('../../journal/runtime-effects', () => ({
  enqueueJournalCreate: vi.fn(),
  initializeJournalCrdt: vi.fn().mockResolvedValue(undefined)
}))

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'sample')

interface FakeTask {
  id: string
  title: string
  dueDate: string | null
  parentId: string | null
  completed: boolean
  archived: boolean
}

function makeDeps(): { deps: NotePlanTaskDeps; tasks: FakeTask[] } {
  const tasks: FakeTask[] = []
  let n = 0
  const deps: NotePlanTaskDeps = {
    async createTask(a) {
      const id = `task-${n++}`
      tasks.push({
        id,
        title: a.title,
        dueDate: a.dueDate,
        parentId: a.parentId,
        completed: false,
        archived: false
      })
      return { success: true, task: { id } }
    },
    async completeTask(a) {
      const t = tasks.find((x) => x.id === a.id)
      if (t) t.completed = true
      return {}
    },
    async archiveTask(id) {
      const t = tasks.find((x) => x.id === id)
      if (t) t.archived = true
      return {}
    },
    getInboxProjectId: () => 'inbox-1'
  }
  return { deps, tasks }
}

describe('notePlanImporter (integration)', () => {
  let tempVault: TestVaultResult
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  let vaultIndex: typeof import('../../vault/index')
  let database: typeof import('../../database')
  let importer: typeof import('./noteplan-importer')
  let importContext: typeof import('../import-context')

  beforeEach(async () => {
    tempVault = createTestVault('noteplan-import-test')
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()

    vaultIndex = await import('../../vault/index')
    database = await import('../../database')

    vi.spyOn(vaultIndex, 'getStatus').mockReturnValue({
      isOpen: true,
      path: tempVault.path,
      isIndexing: false,
      indexProgress: 100,
      error: null
    } satisfies VaultStatus)

    vi.spyOn(vaultIndex, 'getConfig').mockReturnValue({
      excludePatterns: ['.git', 'node_modules', '.trash'],
      defaultNoteFolder: 'notes',
      journalFolder: 'journal',
      attachmentsFolder: 'attachments'
    } satisfies VaultConfig)

    vi.spyOn(database, 'getDatabase').mockReturnValue(dataDb.db)
    vi.spyOn(database, 'getIndexDatabase').mockReturnValue(indexDb.db)
    vi.spyOn(database, 'updateFtsContent').mockImplementation(() => {})

    startProjectionRuntime([createNoteDerivedStateProjector(() => tempVault.path)])

    importer = await import('./noteplan-importer')
    importContext = await import('../import-context')
  })

  afterEach(async () => {
    await stopProjectionRuntime()
    vi.restoreAllMocks()
    indexDb.close()
    dataDb.close()
    tempVault.cleanup()
  })

  it('writes a daily calendar file as a journal entry', async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np1', new AbortController().signal)
    const summary = await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    expect(summary.failed).toEqual([])

    const journalFile = path.join(tempVault.path, 'journal', '2026-08-12.md')
    expect(fs.existsSync(journalFile)).toBe(true)
    const journal = fs.readFileSync(journalFile, 'utf8')
    expect(journal).toContain("date: '2026-08-12'")
    // Tasks became checkboxes carrying a real task id.
    expect(journal).toMatch(/- \[ \] Watch the getting-started video \{task:task-\d+\}/)
    // Checklists became plain checkboxes with no task id.
    expect(journal).toContain('- [ ] 08:00 - 09:00 Reply to emails')
    expect(journal).not.toMatch(/Reply to emails \{task:/)
    // Bullets stayed bullets, wikilinks untouched.
    expect(journal).toContain('- Websites to read later')
    expect(journal).toContain('[[Start Here]]')
    // No placeholder residue survives into the written file.
    expect(journal).not.toContain('np-task')
  })

  it("keeps a daily note's H1 in the body", async () => {
    // A journal entry is keyed by date and has no title field, so a stripped H1
    // would be deleted outright rather than moved onto the entry.
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np8', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const journal = fs.readFileSync(path.join(tempVault.path, 'journal', '2026-08-12.md'), 'utf8')
    expect(journal).toContain('# Monday kickoff')
  })

  it("carries a daily note's frontmatter properties onto the journal entry", async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np9', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const journal = fs.readFileSync(path.join(tempVault.path, 'journal', '2026-08-12.md'), 'utf8')
    // Semantic keys survive; NotePlan's styling keys are dropped, same as the
    // note path.
    expect(journal).toContain('mood')
    expect(journal).toContain('focused')
    expect(journal).not.toContain('rocket')
  })

  it("merges into an existing entry's properties rather than replacing them", async () => {
    // `writeJournalEntryWithContent` replaces rather than merges whenever the
    // properties argument is defined, so an unmerged pass-through would wipe
    // whatever the user already had on the entry.
    fs.writeFileSync(
      path.join(tempVault.path, 'journal', '2026-08-12.md'),
      '---\ndate: 2026-08-12\nproperties:\n  streak: 12\n---\nMy own words.',
      'utf8'
    )

    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np10', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const journal = fs.readFileSync(path.join(tempVault.path, 'journal', '2026-08-12.md'), 'utf8')
    expect(journal).toContain('streak')
    expect(journal).toContain('mood')
  })

  it('creates task rows with due dates, completion and cancellation', async () => {
    const { deps, tasks } = makeDeps()
    const ctx = importContext.createImportContext('np2', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const video = tasks.find((t) => t.title === 'Watch the getting-started video')
    expect(video?.dueDate).toBe('2026-08-13')

    const manual = tasks.find((t) => t.title === 'Read the manual')
    expect(manual?.completed).toBe(true)

    const abandoned = tasks.find((t) => t.title === 'Abandoned idea')
    expect(abandoned?.archived).toBe(true)

    // Checklists never become task rows.
    expect(tasks.some((t) => t.title.includes('Reply to emails'))).toBe(false)
    expect(tasks.some((t) => t.title === 'Gym')).toBe(false)
  })

  it('links a nested task to its parent', async () => {
    const { deps, tasks } = makeDeps()
    const ctx = importContext.createImportContext('np3', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const kickoff = tasks.find((t) => t.title === 'Project kickoff')
    const child = tasks.find((t) => t.title === 'Confirm stakeholders')
    expect(kickoff).toBeDefined()
    expect(child?.parentId).toBe(kickoff?.id)
    expect(kickoff?.dueDate).toBe('2025-11-03')
  })

  it('titles notes from their H1 and mirrors the folder tree', async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np4', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    // start-here.txt has `# Start Here` — the title must come from the H1, not
    // the filename, or `[[Start Here]]` will not resolve.
    expect(fs.existsSync(path.join(tempVault.notesDir, 'NotePlan', 'Start Here.md'))).toBe(true)

    const project = path.join(
      tempVault.notesDir,
      'NotePlan',
      '10 - Projects',
      'Project Aurora Website Redesign.md'
    )
    expect(fs.existsSync(project)).toBe(true)

    // Weekly files have no journal equivalent — they land as notes.
    expect(
      fs.existsSync(path.join(tempVault.notesDir, 'NotePlan', 'Calendar', 'Week 33 review.md'))
    ).toBe(true)
  })

  it('keeps semantic frontmatter and drops NotePlan styling keys', async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np5', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const project = fs.readFileSync(
      path.join(
        tempVault.notesDir,
        'NotePlan',
        '10 - Projects',
        'Project Aurora Website Redesign.md'
      ),
      'utf8'
    )
    expect(project).toContain('status')
    expect(project).toContain('Active')
    expect(project).not.toContain('icon-color')
    expect(project).not.toContain('purple-600')
  })

  it('ignores the Filters folder entirely', async () => {
    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np6', new AbortController().signal)
    const summary = await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    // 2 notes + 1 weekly note + 1 journal entry = 4; nothing from Filters/.
    expect(summary.imported).toBe(4)
    expect(summary.failed).toEqual([])
    expect(fs.existsSync(path.join(tempVault.notesDir, 'NotePlan', 'All Tasks.md'))).toBe(false)
  })

  it('appends to an existing journal entry instead of overwriting it', async () => {
    fs.writeFileSync(
      path.join(tempVault.path, 'journal', '2026-08-12.md'),
      '---\ndate: 2026-08-12\n---\nMy own words.',
      'utf8'
    )

    const { deps } = makeDeps()
    const ctx = importContext.createImportContext('np7', new AbortController().signal)
    await importer.runNotePlanImport({ sourcePaths: [FIXTURE_DIR] }, ctx, deps)

    const journal = fs.readFileSync(path.join(tempVault.path, 'journal', '2026-08-12.md'), 'utf8')
    expect(journal).toContain('My own words.')
    expect(journal).toContain('## Imported from NotePlan')
    expect(journal).toContain('Watch the getting-started video')
  })
})
