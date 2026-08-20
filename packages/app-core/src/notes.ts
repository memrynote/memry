import fs from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { saveCanonicalNote, deleteCanonicalNote, setCanonicalLocalOnly } from '@memry/domain-notes'
import {
  getJournalNoteMetadataByDate,
  getNoteMetadataById,
  getNoteMetadataByPath,
  listNoteMetadata
} from '@memry/storage-data'
import { formatJournalFilename } from '@memry/storage-vault'
import type { DataDb } from './database.ts'
import { createId } from './ids.ts'
import { isDeepStrictEqual } from 'node:util'
import {
  parseMarkdownNote,
  serializeParsedMarkdownNote,
  snippet,
  wordCount,
  writeMarkdownNote
} from './markdown.ts'
import { normalizePath, safeFilename, type VaultConfig } from './paths.ts'
import { resolveWikiTarget as resolveTargetWith } from '@memry/shared/wiki-target'

export interface NoteRecord {
  id: string
  path: string
  title: string
  content: string
  tags: string[]
  properties: Record<string, unknown>
  emoji: string | null
  localOnly: boolean
  createdAt: string
  modifiedAt: string
  journalDate: string | null
  wordCount: number
  snippet: string
}

export interface CreateNoteInput {
  title: string
  content?: string
  folder?: string
  tags?: string[]
  properties?: Record<string, unknown>
}

export interface UpdateNoteInput {
  id: string
  title?: string
  content?: string
  append?: string
  tags?: string[]
  properties?: Record<string, unknown>
}

export interface NoteLinkRecord {
  title: string
  noteId: string | null
  path: string | null
}

export interface NoteLinksResponse {
  outgoing: NoteLinkRecord[]
  backlinks: Array<{ id: string; title: string; path: string }>
}

export interface NotePreviewRecord {
  id: string
  title: string
  emoji: string | null
  snippet: string
  tags: Array<{ name: string; color: string }>
  createdAt: string
}

export interface ResolvedNoteRecord {
  id: string
  path: string
  title: string
  fileType: string
}

export interface ResolvedWikiTargetRecord extends ResolvedNoteRecord {
  /** The heading `[[Note#Heading]]` addresses, or `null` when it names none. */
  heading: string | null
}

interface NoteMetadataRow {
  id: string
  path: string
  title: string
  emoji?: string | null
  fileType?: string
  localOnly?: boolean
  createdAt: string
  modifiedAt: string
  journalDate: string | null
}

export interface NotesService {
  create(input: CreateNoteInput): Promise<NoteRecord>
  get(idOrPath: string): Promise<NoteRecord | null>
  list(options?: { folder?: string; journalOnly?: boolean; limit?: number }): Promise<NoteRecord[]>
  update(input: UpdateNoteInput): Promise<NoteRecord>
  exists(idOrPath: string): Promise<boolean>
  rename(idOrPath: string, newTitle: string): Promise<NoteRecord>
  move(idOrPath: string, newFolder: string): Promise<NoteRecord>
  getLinks(idOrPath: string): Promise<NoteLinksResponse>
  previewByTitle(title: string): Promise<NotePreviewRecord | null>
  resolveByTitle(title: string): Promise<ResolvedNoteRecord | null>
  resolveWikiTarget(target: string): Promise<ResolvedWikiTargetRecord | null>
  setLocalOnly(idOrPath: string, localOnly: boolean): Promise<NoteRecord>
  localOnlyCount(): Promise<{ count: number }>
  delete(idOrPath: string): Promise<boolean>
  getJournalByDate(date: string): Promise<NoteRecord | null>
  upsertJournal(date: string, content: string, mode: 'write' | 'append'): Promise<NoteRecord>
}

function tagsFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter.tags
  if (!Array.isArray(tags)) return []
  return tags.map((tag) => String(tag).trim()).filter(Boolean)
}

function propertiesFromFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const properties = frontmatter.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {}
  return { ...(properties as Record<string, unknown>) }
}

function wikilinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)
  return [...matches].map((match) => match[1]?.trim()).filter((title): title is string => !!title)
}

function notePath(config: VaultConfig, title: string, folder?: string): string {
  const folderPart = folder ? `${normalizePath(folder)}/` : ''
  return normalizePath(`${config.defaultNoteFolder}/${folderPart}${safeFilename(title)}.md`)
}

// Folder of a note relative to defaultNoteFolder ('' = vault root). Tolerant of
// both the flat model (no prefix) and a legacy notes/ prefix; preserves nested
// folders (a plain string replace would mangle multi-level paths).
function noteFolderFromPath(notePathValue: string, defaultNoteFolder: string): string {
  const dir = path.dirname(notePathValue)
  const base = dir === '.' ? '' : dir
  if (!defaultNoteFolder) return base
  if (base === defaultNoteFolder) return ''
  return base.startsWith(`${defaultNoteFolder}/`) ? base.slice(defaultNoteFolder.length + 1) : base
}

function journalPath(config: VaultConfig, date: string): string {
  return normalizePath(
    `${config.journalFolder}/${formatJournalFilename(date, config.journalDateFormat)}.md`
  )
}

async function ensureUniquePath(vaultPath: string, relativePath: string): Promise<string> {
  const ext = path.extname(relativePath)
  const base = relativePath.slice(0, -ext.length)
  let candidate = relativePath
  let index = 2
  while (true) {
    try {
      await fs.access(path.join(vaultPath, candidate))
      candidate = `${base}-${index}${ext}`
      index += 1
    } catch {
      return candidate
    }
  }
}

async function readNote(vaultPath: string, row: NoteMetadataRow): Promise<NoteRecord> {
  const raw = await fs.readFile(path.join(vaultPath, row.path), 'utf-8')
  const parsed = parseMarkdownNote(raw)
  const content = parsed.content
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    content,
    tags: tagsFromFrontmatter(parsed.frontmatter),
    properties: propertiesFromFrontmatter(parsed.frontmatter),
    emoji: row.emoji ?? null,
    localOnly: row.localOnly ?? false,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
    journalDate: row.journalDate,
    wordCount: wordCount(content),
    snippet: snippet(content)
  }
}

function metadataForPath(db: DataDb, idOrPath: string): NoteMetadataRow | undefined {
  const normalized = normalizePath(idOrPath)
  const candidates = [
    normalized,
    normalized.endsWith('.md') ? normalized : `${normalized}.md`,
    normalized.startsWith('notes/') ? normalized : `notes/${normalized}`,
    normalized.startsWith('journal/') ? normalized : `journal/${normalized}`
  ]
  for (const candidate of candidates) {
    const row = getNoteMetadataByPath(db, candidate)
    if (row) return row
  }
  return undefined
}

function getMetadata(db: DataDb, idOrPath: string): NoteMetadataRow | undefined {
  return getNoteMetadataById(db, idOrPath) ?? metadataForPath(db, idOrPath)
}

function saveMetadata(
  db: DataDb,
  input: {
    id: string
    path: string
    title: string
    tags?: string[]
    journalDate?: string | null
    createdAt: string
    modifiedAt: string
    properties?: Record<string, unknown>
    localOnly?: boolean
  }
): void {
  saveCanonicalNote(db, {
    id: input.id,
    path: input.path,
    title: input.title,
    journalDate: input.journalDate ?? null,
    propertyDefinitionNames: input.properties ? Object.keys(input.properties).sort() : [],
    localOnly: input.localOnly,
    createdAt: input.createdAt,
    modifiedAt: input.modifiedAt
  })
}

function metadataByTitle(db: DataDb, title: string): NoteMetadataRow | undefined {
  const rows = listNoteMetadata(db, { limit: 10000 })
  return (
    rows.find((row) => row.title === title) ??
    rows.find((row) => row.title.toLowerCase() === title.toLowerCase())
  )
}

export function createNotesService({
  vaultPath,
  config,
  dataDb
}: {
  vaultPath: string
  config: VaultConfig
  dataDb: DataDb
}): NotesService {
  return {
    async create(input) {
      const now = new Date().toISOString()
      const relativePath = await ensureUniquePath(
        vaultPath,
        notePath(config, input.title, input.folder)
      )
      const id = createId('note')
      // User keys only — Memry identity/dates live in the metadata DB
      const frontmatter = {
        ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
        ...(input.properties && Object.keys(input.properties).length > 0
          ? { properties: input.properties }
          : {})
      }
      const content = input.content ?? ''
      await fs.mkdir(path.dirname(path.join(vaultPath, relativePath)), { recursive: true })
      await fs.writeFile(
        path.join(vaultPath, relativePath),
        writeMarkdownNote(frontmatter, content),
        'utf-8'
      )
      saveMetadata(dataDb, {
        id,
        path: relativePath,
        title: input.title,
        properties: input.properties,
        createdAt: now,
        modifiedAt: now
      })
      return readNote(vaultPath, {
        id,
        path: relativePath,
        title: input.title,
        createdAt: now,
        modifiedAt: now,
        journalDate: null,
        localOnly: false
      })
    },

    async get(idOrPath) {
      const row = getMetadata(dataDb, idOrPath)
      if (!row) return null
      return readNote(vaultPath, row)
    },

    async list(options = {}) {
      // listNoteMetadata filters on the full vault-relative path, so prepend the
      // configured note root (e.g. 'notes'); for a flat vault root it stays as-is.
      const folder = options.folder
        ? [config.defaultNoteFolder, options.folder].filter(Boolean).join('/')
        : undefined
      const rows = listNoteMetadata(dataDb, {
        folder,
        journalOnly: options.journalOnly ?? false,
        limit: options.limit ?? 100
      })
      const notes = await Promise.all(rows.map((row) => readNote(vaultPath, row)))
      return notes
    },

    async update(input) {
      const row = getMetadata(dataDb, input.id)
      if (!row) throw new Error(`Note not found: ${input.id}`)

      const raw = await fs.readFile(path.join(vaultPath, row.path), 'utf-8')
      const parsed = parseMarkdownNote(raw)
      const now = new Date().toISOString()
      const nextTitle = input.title ?? row.title
      const nextProperties =
        input.properties !== undefined
          ? input.properties
          : propertiesFromFrontmatter(parsed.frontmatter)
      const nextContent =
        input.content ??
        (input.append ? `${parsed.content}\n${input.append}`.trim() : parsed.content)
      // User keys only — Memry identity/title/dates live in the metadata DB
      const nextTags = input.tags ?? tagsFromFrontmatter(parsed.frontmatter)
      const nextFrontmatter: Record<string, unknown> = {
        ...parsed.frontmatter,
        ...(Object.keys(nextProperties).length > 0 ? { properties: nextProperties } : {})
      }
      if (nextTags.length > 0) {
        nextFrontmatter.tags = nextTags
      } else {
        delete nextFrontmatter.tags
      }
      if (Object.keys(nextProperties).length === 0) delete nextFrontmatter.properties
      let nextPath = row.path

      if (input.title && input.title !== row.title && !row.journalDate) {
        const folder = noteFolderFromPath(row.path, config.defaultNoteFolder)
        nextPath = await ensureUniquePath(vaultPath, notePath(config, input.title, folder))
        await fs.mkdir(path.dirname(path.join(vaultPath, nextPath)), { recursive: true })
        await fs.rename(path.join(vaultPath, row.path), path.join(vaultPath, nextPath))
      }

      const frontmatterEdited = !isDeepStrictEqual(nextFrontmatter, parsed.frontmatter)
      const nextRaw = serializeParsedMarkdownNote(
        { ...parsed, frontmatter: nextFrontmatter },
        nextContent,
        { frontmatterEdited }
      )
      // Skip identical bytes: no mtime churn for no-op updates
      if (nextPath !== row.path || nextRaw !== raw) {
        await fs.writeFile(path.join(vaultPath, nextPath), nextRaw, 'utf-8')
      }
      saveMetadata(dataDb, {
        id: row.id,
        path: nextPath,
        title: nextTitle,
        properties: nextProperties,
        localOnly: row.localOnly ?? false,
        createdAt: row.createdAt,
        modifiedAt: now,
        journalDate: row.journalDate
      })
      return readNote(vaultPath, {
        ...row,
        path: nextPath,
        title: nextTitle,
        modifiedAt: now
      })
    },

    async exists(idOrPath) {
      return getMetadata(dataDb, idOrPath) !== undefined
    },

    async rename(idOrPath, newTitle) {
      return this.update({ id: idOrPath, title: newTitle })
    },

    async move(idOrPath, newFolder) {
      const row = getMetadata(dataDb, idOrPath)
      if (!row) throw new Error(`Note not found: ${idOrPath}`)
      const note = await readNote(vaultPath, row)
      const normalizedFolder = normalizePath(newFolder)
      const relativePath = normalizePath(
        normalizedFolder
          ? `${config.defaultNoteFolder}/${normalizedFolder}/${path.basename(row.path)}`
          : `${config.defaultNoteFolder}/${path.basename(row.path)}`
      )
      const nextPath =
        relativePath === row.path ? relativePath : await ensureUniquePath(vaultPath, relativePath)
      if (nextPath !== row.path) {
        await fs.mkdir(path.dirname(path.join(vaultPath, nextPath)), { recursive: true })
        await fs.rename(path.join(vaultPath, row.path), path.join(vaultPath, nextPath))
      }
      const now = new Date().toISOString()
      saveMetadata(dataDb, {
        id: row.id,
        path: nextPath,
        title: row.title,
        properties: note.properties,
        localOnly: row.localOnly ?? false,
        createdAt: row.createdAt,
        modifiedAt: now,
        journalDate: row.journalDate
      })
      return readNote(vaultPath, { ...row, path: nextPath, modifiedAt: now })
    },

    async getLinks(idOrPath) {
      const note = await this.get(idOrPath)
      if (!note) throw new Error(`Note not found: ${idOrPath}`)
      const allNotes = [
        ...(await this.list({ limit: 10000 })),
        ...(await this.list({ journalOnly: true, limit: 10000 }))
      ]
      const byTitle = new Map(allNotes.map((item) => [item.title, item]))
      const outgoing = wikilinks(note.content).map((title) => {
        const target = byTitle.get(title)
        return {
          title,
          noteId: target?.id ?? null,
          path: target?.path ?? null
        }
      })
      const backlinks = allNotes
        .filter((item) => item.id !== note.id)
        .filter((item) => wikilinks(item.content).includes(note.title))
        .map((item) => ({ id: item.id, title: item.title, path: item.path }))
      return { outgoing, backlinks }
    },

    async previewByTitle(title) {
      const resolved = metadataByTitle(dataDb, title)
      if (!resolved) return null
      const note = await readNote(vaultPath, resolved)
      return {
        id: note.id,
        title: note.title,
        emoji: note.emoji,
        snippet: note.snippet,
        tags: note.tags.map((name) => ({ name, color: '#6b7280' })),
        createdAt: note.createdAt
      }
    },

    async resolveByTitle(title) {
      const row = metadataByTitle(dataDb, title)
      if (!row) return null
      return {
        id: row.id,
        path: row.path,
        title: row.title,
        fileType: row.fileType ?? 'markdown'
      }
    },

    /**
     * Resolve a wiki-link target — `Note`, `Note#Heading` or `Note#^block-id`.
     *
     * `resolveByTitle` answers "is there a note with this title" and nothing
     * else, so `[[Meeting#Decisions]]` misses it and a CLI or agent following
     * that link gets `null`. This is that lookup with the renderer's
     * split-first/raw-fallback reading layered on top (#1557).
     */
    async resolveWikiTarget(target) {
      const resolved = await resolveTargetWith(target, (title) => this.resolveByTitle(title))
      return resolved ? { ...resolved.match, heading: resolved.heading } : null
    },

    async setLocalOnly(idOrPath, localOnly) {
      const row = getMetadata(dataDb, idOrPath)
      if (!row) throw new Error(`Note not found: ${idOrPath}`)
      setCanonicalLocalOnly(dataDb, row.id, localOnly)
      const note = await this.get(row.id)
      if (!note) throw new Error(`Note not found after local-only update: ${row.id}`)
      return note
    },

    async localOnlyCount() {
      return {
        count: dataDb.select().from(noteMetadata).where(eq(noteMetadata.localOnly, true)).all()
          .length
      }
    },

    async delete(idOrPath) {
      const row = getMetadata(dataDb, idOrPath)
      if (!row) return false
      await fs.rm(path.join(vaultPath, row.path), { force: true })
      deleteCanonicalNote(dataDb, row.id)
      return true
    },

    async getJournalByDate(date) {
      const row = getJournalNoteMetadataByDate(dataDb, date)
      if (!row) return null
      return readNote(vaultPath, row)
    },

    async upsertJournal(date, content, mode) {
      const existing = getJournalNoteMetadataByDate(dataDb, date)
      if (existing) {
        return this.update({
          id: existing.id,
          content: mode === 'write' ? content : undefined,
          append: mode === 'append' ? content : undefined
        })
      }

      const now = new Date().toISOString()
      const id = createId('journal')
      const relativePath = journalPath(config, date)
      await fs.mkdir(path.dirname(path.join(vaultPath, relativePath)), { recursive: true })
      await fs.writeFile(
        path.join(vaultPath, relativePath),
        writeMarkdownNote({}, content),
        'utf-8'
      )
      saveMetadata(dataDb, {
        id,
        path: relativePath,
        title: date,
        createdAt: now,
        modifiedAt: now,
        properties: {},
        journalDate: date
      })
      return readNote(vaultPath, {
        id,
        path: relativePath,
        title: date,
        createdAt: now,
        modifiedAt: now,
        journalDate: date,
        localOnly: false
      })
    }
  }
}
