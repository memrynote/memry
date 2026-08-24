import type { NoteRecord, NotesService } from '@memry/app-core/service-types'
export type {
  NoteRecord,
  CreateNoteInput,
  UpdateNoteInput,
  NoteLinkRecord,
  NoteLinksResponse,
  NotePreviewRecord,
  ResolvedNoteRecord,
  ResolvedWikiTargetRecord,
  NotesService
} from '@memry/app-core/service-types'
import fs from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { saveCanonicalNote, deleteCanonicalNote, setCanonicalLocalOnly } from '@memry/domain-notes'
import { rewriteNoteRefsForMove } from '@memry/editor-schema/note-refs'
import {
  getJournalNoteMetadataByDate,
  getNoteMetadataById,
  getNoteMetadataByPath,
  listNoteMetadata
} from '@memry/storage-data'
import { formatJournalFilename } from '@memry/storage-vault'
import type { DataDb } from './database.ts'
import { createId } from '@memry/app-core/ids'
import { isDeepStrictEqual } from 'node:util'
import {
  parseMarkdownNote,
  serializeParsedMarkdownNote,
  snippet,
  wordCount,
  writeMarkdownNote
} from '@memry/app-core/markdown'
import { normalizePath, safeFilename, type VaultConfig } from './paths.ts'
import { resolveWikiTarget as resolveTargetWith } from '@memry/shared/wiki-target'
import { rewriteWikiLinksForRename } from '@memry/shared/rewrite-wiki-links'

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

// Tags keep their typed case but identity is case-insensitive; on a duplicate
// the first casing wins — same as desktop's `extractTags`.
function tagsFromFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter.tags
  if (!Array.isArray(tags)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const tag of tags) {
    const trimmed = String(tag).trim()
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue
    seen.add(trimmed.toLowerCase())
    result.push(trimmed)
  }
  return result
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

// `folder` is vault-relative, same contract as desktop's `createNote` since
// #1204: a note created inside a folder lands in that folder. Only an unplaced
// note falls back to `defaultNoteFolder` — it is a destination, not a notes
// root.
function notePath(config: VaultConfig, title: string, folder?: string): string {
  const dir = folder ? normalizePath(folder) : normalizePath(config.defaultNoteFolder)
  return normalizePath(`${dir}/${safeFilename(title)}.md`)
}

// The vault-relative folder a note currently sits in ('' = vault root).
function noteFolderOf(notePathValue: string): string {
  const dir = path.dirname(notePathValue)
  return dir === '.' ? '' : normalizePath(dir)
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

// Rename-time vault-wide wiki-link repair (#1711/#1720), mirroring the
// desktop's rename-link-rewrite: wiki-links address notes by TITLE, so a
// rename silently disconnects every inbound `[[Old Title]]` unless the stale
// title is rewritten in every source body — the renamed note's own self-links
// included. A source that fails to read is skipped: the rename itself already
// happened, and repairing nine of ten links beats unwinding it over one
// unreadable file.
async function rewriteInboundLinksForRename(input: {
  vaultPath: string
  dataDb: DataDb
  renamedId: string
  oldTitle: string
  newTitle: string
}): Promise<void> {
  const rows = [
    ...listNoteMetadata(input.dataDb, { limit: 10000 }),
    ...listNoteMetadata(input.dataDb, { journalOnly: true, limit: 10000 })
  ]
  const otherNoteWithTitleExists = (title: string) =>
    rows.some(
      (row) => row.id !== input.renamedId && row.title.toLowerCase() === title.toLowerCase()
    )

  const now = new Date().toISOString()
  for (const row of rows) {
    let raw: string
    try {
      raw = await fs.readFile(path.join(input.vaultPath, row.path), 'utf-8')
    } catch {
      continue
    }
    const parsed = parseMarkdownNote(raw)
    const rewritten = rewriteWikiLinksForRename(
      parsed.content,
      input.oldTitle,
      input.newTitle,
      otherNoteWithTitleExists
    )
    if (rewritten === null) continue
    await fs.writeFile(
      path.join(input.vaultPath, row.path),
      serializeParsedMarkdownNote(parsed, rewritten, { frontmatterEdited: false }),
      'utf-8'
    )
    saveMetadata(input.dataDb, {
      id: row.id,
      path: row.path,
      title: row.title,
      properties: propertiesFromFrontmatter(parsed.frontmatter),
      localOnly: row.localOnly ?? false,
      createdAt: row.createdAt,
      modifiedAt: now,
      journalDate: row.journalDate
    })
  }
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
      // `folder` is vault-relative (#1204): filter on it as-is, never re-root
      // it through `defaultNoteFolder`.
      const folder = options.folder ? normalizePath(options.folder) : undefined
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
      const renamedFromTitle =
        input.title && input.title !== row.title && !row.journalDate ? row.title : null

      if (renamedFromTitle) {
        // A rename stays in the note's current folder — including the vault
        // root, which the `notePath` fallback would re-root under
        // `defaultNoteFolder`.
        const folder = noteFolderOf(row.path)
        nextPath = await ensureUniquePath(
          vaultPath,
          normalizePath(`${folder ? `${folder}/` : ''}${safeFilename(nextTitle)}.md`)
        )
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
      if (renamedFromTitle) {
        await rewriteInboundLinksForRename({
          vaultPath,
          dataDb,
          renamedId: row.id,
          oldTitle: renamedFromTitle,
          newTitle: nextTitle
        })
      }
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
      // `newFolder` is vault-relative and '' means the vault root — never
      // re-root it through `defaultNoteFolder` (desktop `moveNote` contract).
      const normalizedFolder = normalizePath(newFolder)
      const relativePath = normalizePath(
        normalizedFolder
          ? `${normalizedFolder}/${path.basename(row.path)}`
          : path.basename(row.path)
      )
      const nextPath =
        relativePath === row.path ? relativePath : await ensureUniquePath(vaultPath, relativePath)
      if (nextPath !== row.path) {
        await fs.mkdir(path.dirname(path.join(vaultPath, nextPath)), { recursive: true })
        await fs.rename(path.join(vaultPath, row.path), path.join(vaultPath, nextPath))
        // Relative attachment/file refs in the body were written against the old
        // folder; re-point them the way desktop `moveNote` does. Null means no
        // ref moved — skip the write so the file keeps its bytes and mtime.
        const raw = await fs.readFile(path.join(vaultPath, nextPath), 'utf-8')
        const rewritten = rewriteNoteRefsForMove(raw, row.path, nextPath)
        if (rewritten !== null) {
          await fs.writeFile(path.join(vaultPath, nextPath), rewritten, 'utf-8')
        }
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
