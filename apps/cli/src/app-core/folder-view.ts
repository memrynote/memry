import fs from 'node:fs/promises'
import path from 'node:path'
import { parseMarkdownNote, writeMarkdownNote } from '@memry/app-core/markdown'
import type { NoteRecord, NotesService } from './notes.ts'
import { normalizePath, type VaultConfig } from './paths.ts'

export interface FolderViewColumn {
  id: string
  width?: number
  displayName?: string
  showSummary?: boolean
}

export interface FolderViewRecord {
  name: string
  type?: 'table' | 'grid' | 'list' | 'kanban'
  default?: boolean
  columns?: FolderViewColumn[]
  filters?: unknown
  order?: Array<{ property: string; direction: 'asc' | 'desc' }>
  groupBy?: {
    property: string
    direction?: 'asc' | 'desc'
    collapsed?: boolean
    showSummary?: boolean
  }
  limit?: number
  showSummaries?: boolean
}

export interface FolderViewConfig {
  path?: string
  template?: string
  inherit?: boolean
  views?: FolderViewRecord[]
  formulas?: Record<string, string>
  properties?: Record<string, unknown>
  summaries?: Record<string, unknown>
}

export interface FolderViewNote {
  id: string
  path: string
  title: string
  folder: string
  tags: string[]
  created: string
  modified: string
  wordCount: number
  properties: Record<string, unknown>
}

export interface AvailableProperty {
  name: string
  type: string
  usageCount: number
}

export interface FolderSuggestion {
  path: string
  confidence: number
  reason: string
}

export interface FolderViewService {
  getConfig(folderPath: string): Promise<{ config: FolderViewConfig; isDefault: boolean }>
  setConfig(folderPath: string, config: FolderViewConfig): Promise<{ success: true }>
  getViews(folderPath: string): Promise<{ views: FolderViewRecord[]; defaultIndex: number }>
  setView(folderPath: string, view: FolderViewRecord): Promise<{ success: true }>
  deleteView(folderPath: string, viewName: string): Promise<{ success: true }>
  listWithProperties(options: {
    folderPath: string
    limit?: number
    offset?: number
  }): Promise<{ notes: FolderViewNote[]; total: number; hasMore: boolean }>
  getAvailableProperties(folderPath: string): Promise<{
    builtIn: Array<{ id: string; displayName: string; type: string }>
    properties: AvailableProperty[]
    formulas: Array<{ id: string; expression: string }>
  }>
  getFolderSuggestions(noteId: string): Promise<{ suggestions: FolderSuggestion[] }>
  exists(folderPath: string): Promise<boolean>
}

const DEFAULT_VIEW: FolderViewRecord = {
  name: 'Default',
  type: 'table',
  default: true,
  columns: [
    { id: 'title', width: 250 },
    { id: 'folder', width: 120 },
    { id: 'tags', width: 150 },
    { id: 'modified', width: 130 }
  ]
}

const BUILT_IN = [
  { id: 'title', displayName: 'Title', type: 'text' },
  { id: 'folder', displayName: 'Folder', type: 'text' },
  { id: 'tags', displayName: 'Tags', type: 'multiselect' },
  { id: 'created', displayName: 'Created', type: 'date' },
  { id: 'modified', displayName: 'Modified', type: 'date' },
  { id: 'wordCount', displayName: 'WordCount', type: 'number' }
]

function notesDir(vaultPath: string, config: VaultConfig): string {
  return path.join(vaultPath, config.defaultNoteFolder)
}

function configPath(vaultPath: string, config: VaultConfig, folderPath: string): string {
  const normalized = normalizePath(folderPath)
  return path.join(notesDir(vaultPath, config), normalized, '.folder.md')
}

function normalizeConfig(value: Record<string, unknown>, folderPath: string): FolderViewConfig {
  return {
    path: folderPath,
    template: typeof value.template === 'string' ? value.template : undefined,
    inherit: value.inherit === undefined ? undefined : value.inherit !== false,
    views: Array.isArray(value.views) ? (value.views as FolderViewRecord[]) : undefined,
    formulas:
      value.formulas && typeof value.formulas === 'object'
        ? (value.formulas as Record<string, string>)
        : undefined,
    properties:
      value.properties && typeof value.properties === 'object'
        ? (value.properties as Record<string, unknown>)
        : undefined,
    summaries:
      value.summaries && typeof value.summaries === 'object'
        ? (value.summaries as Record<string, unknown>)
        : undefined
  }
}

async function readConfig(
  vaultPath: string,
  config: VaultConfig,
  folderPath: string
): Promise<FolderViewConfig | null> {
  try {
    const raw = await fs.readFile(configPath(vaultPath, config, folderPath), 'utf-8')
    return normalizeConfig(parseMarkdownNote(raw).frontmatter, folderPath)
  } catch {
    return null
  }
}

async function writeConfig(
  vaultPath: string,
  vaultConfig: VaultConfig,
  folderPath: string,
  config: FolderViewConfig
): Promise<void> {
  const frontmatter: Record<string, unknown> = {}
  if (config.template) frontmatter.template = config.template
  if (config.inherit === false) frontmatter.inherit = false
  if (config.views?.length) frontmatter.views = config.views
  if (config.formulas && Object.keys(config.formulas).length > 0)
    frontmatter.formulas = config.formulas
  if (config.properties && Object.keys(config.properties).length > 0) {
    frontmatter.properties = config.properties
  }
  if (config.summaries && Object.keys(config.summaries).length > 0) {
    frontmatter.summaries = config.summaries
  }

  const target = configPath(vaultPath, vaultConfig, folderPath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, writeMarkdownNote(frontmatter, ''), 'utf-8')
}

function relativeFolder(note: NoteRecord, folderPath: string): string {
  const folder = normalizePath(folderPath)
  const withoutRoot = note.path.replace(/^notes\/?/, '')
  const noteFolder = path.posix.dirname(withoutRoot)
  if (!folder) return noteFolder ? `/${noteFolder}` : '/'
  if (noteFolder === folder) return '/'
  return noteFolder.startsWith(`${folder}/`) ? `/${noteFolder.slice(folder.length + 1)}` : '/'
}

function noteFolder(note: NoteRecord, config: VaultConfig): string {
  const withoutRoot = note.path.replace(new RegExp(`^${config.defaultNoteFolder}/?`), '')
  const folder = path.posix.dirname(withoutRoot)
  return folder === '.' ? '' : normalizePath(folder)
}

async function walkFolderPaths(
  root: string,
  hiddenTopLevel: Set<string>,
  current = ''
): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, current), { withFileTypes: true })
  const folders: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // Skip hidden dirs (.memry, .obsidian, .git) and structural/excluded folders
    // (journal, attachments, excludePatterns) — relevant once the notes root is the
    // vault root (defaultNoteFolder = ''). Mirrors folders.ts walkFolders.
    if (entry.name.startsWith('.')) continue
    if (current === '' && hiddenTopLevel.has(entry.name)) continue
    const relative = normalizePath(path.join(current, entry.name))
    folders.push(relative)
    folders.push(...(await walkFolderPaths(root, hiddenTopLevel, relative)))
  }
  return folders
}

function inferPropertyType(value: unknown): string {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'checkbox'
  if (Array.isArray(value)) return 'multiselect'
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'date'
  return 'text'
}

export function createFolderViewService({
  vaultPath,
  config,
  notes
}: {
  vaultPath: string
  config: VaultConfig
  notes: NotesService
}): FolderViewService {
  return {
    async getConfig(folderPath) {
      const existing = await readConfig(vaultPath, config, folderPath)
      if (!existing?.views?.length) {
        return { config: { path: folderPath, views: [DEFAULT_VIEW] }, isDefault: true }
      }
      return { config: { path: folderPath, ...existing }, isDefault: false }
    },

    async setConfig(folderPath, nextConfig) {
      const existing = (await readConfig(vaultPath, config, folderPath)) ?? {}
      await writeConfig(vaultPath, config, folderPath, { ...existing, ...nextConfig })
      return { success: true }
    },

    async getViews(folderPath) {
      const existing = await readConfig(vaultPath, config, folderPath)
      const views = existing?.views?.length ? existing.views : [DEFAULT_VIEW]
      const defaultIndex = Math.max(
        0,
        views.findIndex((view) => view.default)
      )
      return { views, defaultIndex }
    },

    async setView(folderPath, view) {
      if (!view.name.trim()) throw new Error('Folder view name is required')
      const existing = (await readConfig(vaultPath, config, folderPath)) ?? {}
      const views = [...(existing.views ?? [])]
      const index = views.findIndex((candidate) => candidate.name === view.name)
      if (index >= 0) views[index] = view
      else views.push(view)
      if (view.default) {
        views.forEach((candidate) => {
          candidate.default = candidate.name === view.name
        })
      }
      await writeConfig(vaultPath, config, folderPath, { ...existing, views })
      return { success: true }
    },

    async deleteView(folderPath, viewName) {
      const existing = (await readConfig(vaultPath, config, folderPath)) ?? {}
      const views = (existing.views ?? []).filter((view) => view.name !== viewName)
      if (views.length > 0 && !views.some((view) => view.default)) views[0].default = true
      await writeConfig(vaultPath, config, folderPath, { ...existing, views })
      return { success: true }
    },

    async listWithProperties(options) {
      const limit = options.limit ?? 100
      const offset = options.offset ?? 0
      const rows = await notes.list({ folder: options.folderPath, limit: offset + limit + 1 })
      const selected = rows.slice(offset, offset + limit)
      return {
        notes: selected.map((note) => ({
          id: note.id,
          path: note.path,
          title: note.title,
          folder: relativeFolder(note, options.folderPath),
          tags: note.tags,
          created: note.createdAt,
          modified: note.modifiedAt,
          wordCount: note.wordCount,
          properties: note.properties
        })),
        total: rows.length,
        hasMore: rows.length > offset + limit
      }
    },

    async getAvailableProperties(folderPath) {
      const rows = await notes.list({ folder: folderPath, limit: 10000 })
      const counts = new Map<string, { usageCount: number; type: string }>()
      for (const note of rows) {
        for (const [name, value] of Object.entries(note.properties)) {
          const current = counts.get(name)
          counts.set(name, {
            usageCount: (current?.usageCount ?? 0) + 1,
            type: current?.type ?? inferPropertyType(value)
          })
        }
      }
      const existing = await readConfig(vaultPath, config, folderPath)
      return {
        builtIn: BUILT_IN,
        properties: [...counts.entries()]
          .map(([name, value]) => ({ name, ...value }))
          .sort((a, b) => b.usageCount - a.usageCount),
        formulas: Object.entries(existing?.formulas ?? {}).map(([id, expression]) => ({
          id,
          expression
        }))
      }
    },

    async getFolderSuggestions(noteId) {
      const note = await notes.get(noteId)
      if (!note) return { suggestions: [] }

      const currentFolder = noteFolder(note, config)
      const root = notesDir(vaultPath, config)
      const hiddenTopLevel = new Set(
        [config.journalFolder, config.attachmentsFolder, ...config.excludePatterns]
          .filter(Boolean)
          .map((p) => normalizePath(p).split('/')[0])
      )
      const folders = (await walkFolderPaths(root, hiddenTopLevel)).filter(
        (folder) => folder !== currentFolder
      )

      const suggestions = await Promise.all(
        folders.map(async (folder) => {
          const count = (await notes.list({ folder, limit: 10000 })).length
          return {
            path: folder,
            confidence: Math.min(0.8, 0.4 + count * 0.05),
            reason: count === 1 ? 'Contains 1 note' : `Contains ${count} notes`
          }
        })
      )

      return {
        suggestions: suggestions
          .sort((left, right) => {
            if (right.confidence !== left.confidence) return right.confidence - left.confidence
            return left.path.localeCompare(right.path)
          })
          .slice(0, 3)
      }
    },

    async exists(folderPath) {
      try {
        const stat = await fs.stat(
          path.join(notesDir(vaultPath, config), normalizePath(folderPath))
        )
        return stat.isDirectory()
      } catch {
        return false
      }
    }
  }
}
