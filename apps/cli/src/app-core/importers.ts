import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ImportPreview, ImportPreviewGroup } from '@memry/contracts/import-channels'
import { parseCsv, mapRows } from '@memry/importers/csv'
import { extractAssetRefs, mapFiles, parseFrontmatter } from '@memry/importers/markdown'
import type { FileDescriptor } from '@memry/importers/markdown'
import { indexBlocks, mapPages } from '@memry/importers/roam'
import type { RoamPage } from '@memry/importers/roam'
import { IMPORT_MESSAGE_CODES } from '@memry/importers/messages'
import type { NotesService } from './notes.ts'

// The CLI side of desktop's import framework (apps/desktop/src/main/import/).
// The parsing and mapping are the shared `@memry/importers` package, the same
// code the desktop importers run. What the CLI cannot reuse is desktop's writer
// (`createImportedNote`: tasks domain, attachments, projections, Electron), so
// each importer here only plans notes and the CLI writes them through its own
// notes service. Importers that need that writer, a database reader, or an
// account stay in the desktop app; `sources` says which and why.

export type ImporterId = string

export interface ImporterInfo {
  id: ImporterId
  name: string
  /** File extensions the importer reads; a folder is accepted where `directory` is set. */
  extensions: string[]
  directory: boolean
  /** Runs from the CLI. The rest are listed so the catalog matches the desktop app. */
  cli: boolean
  /** Why a source does not run from the CLI. */
  reason?: string
}

export interface ImportRunSummary {
  importer: ImporterId
  imported: number
  /** Always 0: the CLI writes notes only. Attachments need the desktop importer. */
  attachments: number
  skipped: number
  failed: Array<{ item: string; error: string }>
  warnings: string[]
  notes: Array<{ id: string; title: string; path: string }>
}

export interface ImportOptions {
  /** Vault folder that replaces the importer's own root folder (`Markdown`, `CSV`, `Roam`). */
  folder?: string
}

export interface ImportService {
  sources(): ImporterInfo[]
  preview(
    importerId: ImporterId,
    sourcePaths: string[],
    options?: ImportOptions
  ): Promise<ImportPreview>
  start(
    importerId: ImporterId,
    sourcePaths: string[],
    options?: ImportOptions
  ): Promise<ImportRunSummary>
}

interface PlannedNote {
  /** The source file the note came from, for preview grouping. */
  source: string
  title: string
  content: string
  folder: string
  tags?: string[]
  properties?: Record<string, unknown>
}

interface ImportPlan {
  notes: PlannedNote[]
  failed: Array<{ item: string; error: string }>
  skipped: number
  warnings: string[]
  /** The importer's own root folder, which `--folder` replaces. */
  root: string
}

interface CliImporter extends ImporterInfo {
  plan(sourcePaths: string[]): Promise<ImportPlan>
}

const DESKTOP_ONLY = 'Needs the desktop app'

function desktopOnly(
  id: string,
  name: string,
  extensions: string[],
  reason: string,
  directory = false
): ImporterInfo {
  return { id, name, extensions, directory, cli: false, reason }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const MD_EXTENSIONS = new Set(['.md', '.markdown'])

async function collectMarkdownFiles(
  dir: string,
  rootDir: string,
  out: FileDescriptor[]
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectMarkdownFiles(absPath, rootDir, out)
    } else if (entry.isFile() && MD_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push({ relPath: path.relative(rootDir, absPath), absPath, rootDir })
    }
  }
}

const markdownImporter: CliImporter = {
  id: 'markdown',
  name: 'Markdown',
  extensions: ['md', 'markdown'],
  directory: true,
  cli: true,
  async plan(sourcePaths) {
    const failed: ImportPlan['failed'] = []
    const descriptors: FileDescriptor[] = []
    for (const sourcePath of sourcePaths) {
      try {
        if ((await stat(sourcePath)).isDirectory()) {
          await collectMarkdownFiles(sourcePath, sourcePath, descriptors)
        } else if (MD_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
          descriptors.push({
            relPath: path.basename(sourcePath),
            absPath: sourcePath,
            rootDir: path.dirname(sourcePath)
          })
        } else {
          failed.push({ item: sourcePath, error: 'Not a markdown file or folder' })
        }
      } catch (error) {
        failed.push({ item: sourcePath, error: errorText(error) })
      }
    }

    const notes: PlannedNote[] = []
    let assetRefs = 0
    for (const notePlan of mapFiles(descriptors).notes) {
      try {
        const { title, tags, properties, body } = parseFrontmatter(
          await readFile(notePlan.absPath, 'utf8')
        )
        assetRefs += extractAssetRefs(body).length
        notes.push({
          source: notePlan.absPath,
          title: title || notePlan.title,
          content: body,
          folder: notePlan.vaultFolder,
          tags,
          properties
        })
      } catch (error) {
        failed.push({ item: notePlan.absPath, error: errorText(error) })
      }
    }
    const warnings =
      assetRefs > 0
        ? [
            `${assetRefs} image/file reference(s) point at local files. The CLI does not copy them into the vault; import from the desktop app to bring attachments along.`
          ]
        : []
    return { notes, failed, skipped: 0, warnings, root: 'Markdown' }
  }
}

const csvImporter: CliImporter = {
  id: 'csv',
  name: 'CSV',
  extensions: ['csv'],
  directory: false,
  cli: true,
  async plan(sourcePaths) {
    const failed: ImportPlan['failed'] = []
    const notes: PlannedNote[] = []
    const warnings: string[] = []
    let skipped = 0
    for (const sourcePath of sourcePaths) {
      try {
        const plan = mapRows(parseCsv(await readFile(sourcePath, 'utf8')))
        skipped += plan.stats.skipped
        for (const warning of plan.warnings)
          warnings.push(`${path.basename(sourcePath)}: ${warning.message}`)
        for (const note of plan.notes) {
          notes.push({
            source: sourcePath,
            title: note.title,
            content: note.content,
            folder: note.folder,
            properties: note.properties
          })
        }
      } catch (error) {
        failed.push({ item: sourcePath, error: errorText(error) })
      }
    }
    return { notes, failed, skipped, warnings, root: 'CSV' }
  }
}

function isRoamPageArray(value: unknown): value is RoamPage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (page) =>
        typeof page === 'object' &&
        page !== null &&
        typeof (page as { title?: unknown }).title === 'string'
    )
  )
}

const roamImporter: CliImporter = {
  id: 'roam',
  name: 'Roam',
  extensions: ['json'],
  directory: false,
  cli: true,
  async plan(sourcePaths) {
    const failed: ImportPlan['failed'] = []
    const pagesBySource: Array<{ source: string; pages: RoamPage[] }> = []
    for (const sourcePath of sourcePaths) {
      try {
        const parsed: unknown = JSON.parse(await readFile(sourcePath, 'utf8'))
        if (!isRoamPageArray(parsed)) {
          failed.push({
            item: sourcePath,
            error: 'Not a Roam JSON export (expected an array of pages)'
          })
          continue
        }
        pagesBySource.push({ source: sourcePath, pages: parsed })
      } catch (error) {
        failed.push({ item: sourcePath, error: errorText(error) })
      }
    }
    // Block references resolve across every file, so the index spans them all.
    const allPages = pagesBySource.flatMap((entry) => entry.pages)
    const index = indexBlocks(allPages)
    const notes: PlannedNote[] = []
    for (const { source, pages } of pagesBySource) {
      for (const note of mapPages(pages, index).notes) {
        notes.push({ source, title: note.title, content: note.body, folder: note.folder })
      }
    }
    return {
      notes,
      failed,
      skipped: 0,
      warnings:
        notes.length > 0
          ? ['Page created/edited times are not carried over by the CLI import.']
          : [],
      root: 'Roam'
    }
  }
}

const IMPLEMENTED: CliImporter[] = [markdownImporter, csvImporter, roamImporter]

// Same ids and names as desktop's built-in registry (register-builtins.ts).
const CATALOG: ImporterInfo[] = [
  // oxlint-disable-next-line typescript/unbound-method -- rest-destructuring only drops `plan`; it is never called detached
  ...IMPLEMENTED.map(({ plan: _plan, ...info }) => info),
  desktopOnly(
    'apple-journal',
    'Apple Journal',
    ['html', 'htm'],
    `${DESKTOP_ONLY}: it imports entries through desktop's note and attachment writer.`
  ),
  desktopOnly(
    'apple-notes',
    'Apple Notes',
    ['sqlite'],
    `${DESKTOP_ONLY}: it reads the macOS Notes container, which the OS grants through the file picker, and unlocks password-protected notes with a password the app asks for.`,
    true
  ),
  desktopOnly(
    'bear',
    'Bear',
    ['bear2bk', 'zip'],
    `${DESKTOP_ONLY}: it imports attachments from the archive.`
  ),
  desktopOnly(
    'evernote',
    'Evernote',
    ['enex'],
    `${DESKTOP_ONLY}: it imports attachments from the export.`
  ),
  desktopOnly(
    'google-keep',
    'Google Keep',
    ['json', 'zip'],
    `${DESKTOP_ONLY}: it imports attachments and checklists as tasks.`
  ),
  desktopOnly('html', 'HTML', ['html', 'htm'], `${DESKTOP_ONLY}: it imports linked assets.`),
  desktopOnly(
    'noteplan',
    'NotePlan',
    [],
    `${DESKTOP_ONLY}: it imports journals, tasks and attachments.`,
    true
  ),
  desktopOnly(
    'notion',
    'Notion',
    ['zip'],
    `${DESKTOP_ONLY}: it imports attachments from the export.`
  ),
  desktopOnly(
    'onenote',
    'OneNote',
    [],
    `${DESKTOP_ONLY}: it signs in to a Microsoft account in the browser.`
  ),
  desktopOnly(
    'raindrop',
    'Raindrop',
    ['csv'],
    `${DESKTOP_ONLY}: it files bookmarks into the inbox.`
  ),
  desktopOnly(
    'readwise',
    'Readwise',
    [],
    `${DESKTOP_ONLY}: it pulls through the desktop app's Readwise connection. See \`readwise status\`.`
  ),
  desktopOnly(
    'ticktick',
    'TickTick',
    ['csv'],
    `${DESKTOP_ONLY}: it creates tasks and projects through the tasks domain.`
  ),
  desktopOnly(
    'todoist',
    'Todoist',
    ['csv'],
    `${DESKTOP_ONLY}: it creates tasks and projects through the tasks domain.`
  )
].toSorted((a, b) => a.name.localeCompare(b.name))

/** A usable `--folder`: relative, no traversal. Checked once, before anything is written. */
function cleanFolderOverride(override: string | undefined): string | undefined {
  if (override === undefined) return undefined
  const clean = override.replace(/^\/+|\/+$/g, '')
  if (!clean || clean.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`Invalid import folder: ${override}`)
  }
  return clean
}

/** Re-roots a planned folder: `Markdown/notes` -> `<override>/notes`. */
function reroot(folder: string, root: string, override: string | undefined): string {
  if (!override) return folder
  if (folder === root) return override
  return folder.startsWith(`${root}/`)
    ? `${override}${folder.slice(root.length)}`
    : `${override}/${folder}`
}

function requireImporter(id: ImporterId): CliImporter {
  const implemented = IMPLEMENTED.find((importer) => importer.id === id)
  if (implemented) return implemented
  const known = CATALOG.find((importer) => importer.id === id)
  if (known)
    throw new Error(`The ${known.name} importer is not available from the CLI. ${known.reason}`)
  throw new Error(`Unknown import source: ${id}. Run \`memrynote import sources\` to list them.`)
}

function hasChecklist(content: string): boolean {
  return /^\s*[-*+]\s+\[[ xX]\]/m.test(content)
}

async function planFor(
  importerId: ImporterId,
  sourcePaths: string[],
  options: ImportOptions
): Promise<{ plan: ImportPlan; folderFor: (note: PlannedNote) => string }> {
  const importer = requireImporter(importerId)
  const folderOverride = cleanFolderOverride(options.folder)
  if (sourcePaths.length === 0) throw new Error('Missing source path')
  const plan = await importer.plan(sourcePaths)
  return { plan, folderFor: (note) => reroot(note.folder, plan.root, folderOverride) }
}

export function createImportService({
  notes
}: {
  notes: Pick<NotesService, 'create'>
}): ImportService {
  return {
    sources() {
      return CATALOG
    },

    async preview(importerId, sourcePaths, options = {}) {
      const { plan } = await planFor(importerId, sourcePaths, options)
      const groups: ImportPreviewGroup[] = sourcePaths.map((source) => {
        const own = plan.notes.filter(
          (note) => note.source === source || note.source.startsWith(source + path.sep)
        )
        const error = plan.failed.find((entry) => entry.item === source)
        return {
          label: path.basename(source),
          counts: [{ labelKey: 'import.stats.notes', value: own.length }],
          sampleTitles: own.slice(0, 5).map((note) => note.title),
          ...(error
            ? { error: { code: IMPORT_MESSAGE_CODES.readFileFailed, message: error.error } }
            : {})
        }
      })
      if (plan.warnings.length > 0 && groups.length > 0) {
        groups[0] = { ...groups[0], warnings: plan.warnings }
      }
      return { groups }
    },

    async start(importerId, sourcePaths, options = {}) {
      const { plan, folderFor } = await planFor(importerId, sourcePaths, options)
      const failed = [...plan.failed]
      const created: ImportRunSummary['notes'] = []
      let checklists = 0
      for (const note of plan.notes) {
        try {
          const record = await notes.create({
            title: note.title,
            content: note.content,
            folder: folderFor(note),
            tags: note.tags,
            properties: note.properties
          })
          if (hasChecklist(note.content)) checklists += 1
          created.push({ id: record.id, title: record.title, path: record.path })
        } catch (error) {
          failed.push({ item: note.title, error: errorText(error) })
        }
      }
      const warnings = [...plan.warnings]
      if (checklists > 0) {
        warnings.push(
          `${checklists} note(s) contain checklists. The CLI keeps them as plain markdown; the desktop import turns them into tasks.`
        )
      }
      return {
        importer: importerId,
        imported: created.length,
        attachments: 0,
        skipped: plan.skipped,
        failed,
        warnings,
        notes: created
      }
    }
  }
}
