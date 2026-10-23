import fs from 'node:fs/promises'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { notePositions, taskNotes, tasks } from '@memry/db-schema/data-schema'
import { getNoteMetadataById, getNoteMetadataByPath, listNoteMetadata } from '@memry/storage-data'
import {
  parseMarkdownNote,
  serializeParsedMarkdownNote,
  type ParsedMarkdownNote
} from '@memry/app-core/markdown'
import { classifyMarkdownStat } from '@memry/shared/markdown-class'
import {
  applyAliasDelta,
  MAX_NOTE_ALIASES,
  MAX_NOTE_ALIAS_LENGTH,
  pickWikiTarget
} from '@memry/shared/note-names'
import { foldTag } from '@memry/shared/tag-fold'
import { scanTaskCheckboxStates } from '@memry/shared/task-block'
import { substituteTemplatePlaceholders } from '@memry/shared/template-placeholders'
import { findUnlinkedMentions } from '@memry/shared/unlinked-mentions'
import { extractWikiLinks } from '@memry/shared/wiki-target'
import type { DataDb } from './database.ts'
import { aliasesFromFrontmatter } from './note-aliases.ts'
import type { NotesService } from './notes.ts'
import { normalizePath } from './paths.ts'
import type { TemplatesService } from './templates.ts'
import { iterateFileLines, MAX_LINE_CHARS } from './note-large-file.ts'

export interface AliasEditInput {
  add?: string[]
  remove?: string[]
  /** Replace the whole list. Applied as a delta, so it cannot be combined with add/remove. */
  set?: string[]
}

export interface UnlinkedMentionRecord {
  sourceId: string
  sourcePath: string
  sourceTitle: string
  contexts: Array<{ snippet: string; linkStart: number; linkEnd: number }>
}

export interface LargeFileLinesRecord {
  startLine: number
  lines: string[]
  /** 0-based line numbers cut at the per-line cap. */
  truncated: number[]
  /** True when the file has no line after the last one returned. */
  endOfFile: boolean
}

export interface LargeFileSearchRecord {
  status: 'complete'
  query: string
  hits: Array<{ line: number; ordinal: number }>
  total: number
  limited: boolean
}

export interface NoteToolsService {
  aliases(idOrPath: string, edit?: AliasEditInput): Promise<{ aliases: string[] }>
  resolveTitles(titles: string[]): Promise<Record<string, { id: string; path: string } | null>>
  applyTemplate(
    idOrPath: string,
    templateId: string,
    mode?: 'full' | 'body'
  ): Promise<Awaited<ReturnType<NotesService['update']>>>
  unlinkedMentions(idOrPath: string): Promise<UnlinkedMentionRecord[]>
  linkMention(input: {
    sourceId: string
    targetId: string
    ordinal: number
  }): Promise<{ linked: boolean }>
  carriedTasks(input: { noteIds: string[]; folderPaths: string[] }): Promise<{ taskIds: string[] }>
  positions(folderPath?: string): Promise<{ positions: Record<string, number> }>
  reorder(folderPath: string, notePaths: string[]): Promise<{ success: true }>
  getFolderTemplate(folderPath: string): Promise<{ folder: string; template: string | null }>
  setFolderTemplate(
    folderPath: string,
    templateId: string | null
  ): Promise<{ folder: string; template: string | null }>
  readLines(idOrPath: string, startLine: number, count: number): Promise<LargeFileLinesRecord>
  grep(idOrPath: string, query: string): Promise<LargeFileSearchRecord>
}

const SNIPPET_RADIUS = 60
const MAX_READ_LINES = 2000
const MAX_SEARCH_HITS = 2000
const MAX_QUERY_LENGTH = 200

interface LoadedNote {
  id: string
  path: string
  title: string
  journal: boolean
  content: string
  aliases: string[]
}

// Folder args are vault-relative; '' and '.' are the vault root.
function folderArg(folderPath: string | undefined): string {
  const normalized = normalizePath(folderPath ?? '')
  return normalized === '.' ? '' : normalized
}

function snippetAround(
  body: string,
  start: number,
  end: number
): UnlinkedMentionRecord['contexts'][number] {
  const from = Math.max(0, start - SNIPPET_RADIUS)
  const to = Math.min(body.length, end + SNIPPET_RADIUS)
  const lead = from > 0 ? '…' : ''
  const raw = body.slice(from, to)
  const snippet = `${lead}${raw}${to < body.length ? '…' : ''}`.replace(/\s/g, ' ')
  return { snippet, linkStart: lead.length + start - from, linkEnd: lead.length + end - from }
}

export function createNoteToolsService({
  vaultPath,
  dataDb,
  notes,
  templates
}: {
  vaultPath: string
  dataDb: DataDb
  notes: NotesService
  templates: TemplatesService
}): NoteToolsService {
  async function requireNote(idOrPath: string) {
    const note = await notes.get(idOrPath)
    if (!note) throw new Error(`Note not found: ${idOrPath}`)
    return note
  }

  async function loadAll(): Promise<LoadedNote[]> {
    const rows = [
      ...listNoteMetadata(dataDb, { limit: 10000 }),
      ...listNoteMetadata(dataDb, { journalOnly: true, limit: 10000 })
    ]
    const loaded: LoadedNote[] = []
    for (const row of rows) {
      if (row.fileType && row.fileType !== 'markdown') continue
      try {
        const parsed = parseMarkdownNote(await fs.readFile(path.join(vaultPath, row.path), 'utf-8'))
        loaded.push({
          id: row.id,
          path: row.path,
          title: row.title,
          journal: row.journalDate !== null,
          content: parsed.content,
          aliases: aliasesFromFrontmatter(parsed.frontmatter, row.title)
        })
      } catch {
        // An unreadable note takes no part in name lookups.
      }
    }
    return loaded
  }

  // A file's absolute path for a streaming read, without loading it. Indexed
  // notes resolve by id or path; a vault file the CLI never indexed (a large
  // log dropped into the vault) resolves by its vault-relative path.
  function resolveFile(idOrPath: string): string {
    const normalized = normalizePath(idOrPath)
    const row =
      getNoteMetadataById(dataDb, idOrPath) ??
      getNoteMetadataByPath(dataDb, normalized) ??
      getNoteMetadataByPath(dataDb, normalized.endsWith('.md') ? normalized : `${normalized}.md`)
    const relative = row?.path ?? normalized
    const root = path.resolve(vaultPath)
    const absolute = path.resolve(root, relative)
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      throw new Error('File must be inside the vault')
    }
    return absolute
  }

  async function assertFile(absolute: string, label: string): Promise<void> {
    const stat = await fs.stat(absolute).catch(() => null)
    if (!stat?.isFile()) throw new Error(`Note not found: ${label}`)
  }

  async function readFolderTemplateOf(folder: string): Promise<{
    template: string | null
    inherit: boolean
  }> {
    try {
      const raw = await fs.readFile(path.join(vaultPath, folder, '.folder.md'), 'utf-8')
      const { frontmatter } = parseMarkdownNote(raw)
      return {
        template:
          typeof frontmatter.template === 'string' && frontmatter.template
            ? frontmatter.template
            : null,
        inherit: frontmatter.inherit !== false
      }
    } catch {
      return { template: null, inherit: true }
    }
  }

  return {
    async aliases(idOrPath, edit = {}) {
      const note = await requireNote(idOrPath)
      const absolute = path.join(vaultPath, note.path)
      const raw = await fs.readFile(absolute, 'utf-8')
      const parsed = parseMarkdownNote(raw)
      const before = aliasesFromFrontmatter(parsed.frontmatter, note.title)

      if (edit.set && (edit.add?.length || edit.remove?.length)) {
        throw new Error('Use --set on its own, or --add/--remove')
      }
      const add = edit.set ?? edit.add ?? []
      const remove = edit.set ? before : (edit.remove ?? [])
      if (add.length === 0 && remove.length === 0) return { aliases: before }
      for (const name of add) {
        if (name.trim().length > MAX_NOTE_ALIAS_LENGTH) {
          throw new Error(`Alias is longer than ${MAX_NOTE_ALIAS_LENGTH} characters`)
        }
      }
      if (add.length > MAX_NOTE_ALIASES || remove.length > MAX_NOTE_ALIASES) {
        throw new Error(`A note holds at most ${MAX_NOTE_ALIASES} aliases`)
      }

      const after = applyAliasDelta(note.title, before, { add, remove })
      if (JSON.stringify(before) === JSON.stringify(after)) return { aliases: before }

      const frontmatter = { ...parsed.frontmatter }
      if (after.length > 0) frontmatter.aliases = after
      else delete frontmatter.aliases
      await fs.writeFile(
        absolute,
        serializeParsedMarkdownNote(
          { ...parsed, frontmatter } as ParsedMarkdownNote,
          parsed.content,
          {
            frontmatterEdited: true
          }
        ),
        'utf-8'
      )
      // The bytes are already on disk, so this only re-saves the metadata row.
      await notes.update({ id: note.id })
      return { aliases: after }
    },

    async resolveTitles(titles) {
      const all = await loadAll()
      const candidates = all.map((note) => ({
        noteId: note.id,
        path: note.path,
        title: note.title,
        aliases: note.aliases,
        journal: note.journal
      }))
      const out: Record<string, { id: string; path: string } | null> = {}
      for (const title of titles) {
        const match = pickWikiTarget(title, candidates)
        out[title] = match ? { id: match.noteId, path: match.path } : null
      }
      return out
    },

    async applyTemplate(idOrPath, templateId, mode = 'full') {
      const note = await requireNote(idOrPath)
      const template = await templates.get(templateId)
      if (!template) {
        throw new Error(
          `Template not found: ${templateId}. Built-in templates are only available in the desktop app.`
        )
      }
      const content = substituteTemplatePlaceholders(template.content, note.title)
      if (mode === 'body') return notes.update({ id: note.id, content })

      // Same as desktop's buildTemplateApplyUpdate: tags are added without
      // dropping the note's own, and the note's property values win.
      const key = (tag: string) => foldTag(tag.trim())
      const tags = [...note.tags]
      for (const tag of template.tags) {
        if (tag.trim() && !tags.some((held) => key(held) === key(tag))) tags.push(tag.trim())
      }
      const templateProperties: Record<string, unknown> = {}
      for (const property of template.properties) templateProperties[property.name] = property.value
      return notes.update({
        id: note.id,
        content,
        tags,
        properties: { ...templateProperties, ...note.properties }
      })
    },

    async unlinkedMentions(idOrPath) {
      const target = await requireNote(idOrPath)
      const all = await loadAll()
      const targetEntry = all.find((note) => note.id === target.id)
      const names = [target.title, ...(targetEntry?.aliases ?? [])]
      const candidates = all.map((note) => ({
        noteId: note.id,
        path: note.path,
        title: note.title,
        aliases: note.aliases,
        journal: note.journal
      }))

      const out: UnlinkedMentionRecord[] = []
      for (const source of all) {
        if (source.id === target.id) continue
        // A source that already links to the note is a backlink, not a mention.
        const linked = extractWikiLinks(source.content).some(
          (link) => pickWikiTarget(link, candidates)?.noteId === target.id
        )
        if (linked) continue
        const mentions = findUnlinkedMentions(source.content, names)
        if (mentions.length === 0) continue
        out.push({
          sourceId: source.id,
          sourcePath: source.path,
          sourceTitle: source.title,
          contexts: mentions.map((mention) =>
            snippetAround(source.content, mention.start, mention.end)
          )
        })
      }
      return out.sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle))
    },

    async linkMention({ sourceId, targetId, ordinal }) {
      const target = await requireNote(targetId)
      const source = await requireNote(sourceId)
      const all = await loadAll()
      const names = [target.title, ...(all.find((note) => note.id === target.id)?.aliases ?? [])]
      const mention = findUnlinkedMentions(source.content, names)[ordinal]
      if (!mention) return { linked: false }
      const link =
        mention.text === target.title
          ? `[[${target.title}]]`
          : `[[${target.title}|${mention.text}]]`
      await notes.update({
        id: source.id,
        content: source.content.slice(0, mention.start) + link + source.content.slice(mention.end)
      })
      return { linked: true }
    },

    async carriedTasks({ noteIds, folderPaths }) {
      const paths = new Map<string, string>()
      for (const noteId of noteIds) {
        const row = getNoteMetadataById(dataDb, noteId)
        if (row) paths.set(row.id, row.path)
      }
      for (const folderPath of folderPaths) {
        const folder = folderArg(folderPath)
        for (const row of listNoteMetadata(dataDb, { folder, limit: 10000 })) {
          paths.set(row.id, row.path)
        }
      }

      const deleting = new Set(paths.keys())
      const found = new Set<string>()
      for (const relative of paths.values()) {
        const absolute = path.join(vaultPath, relative)
        // A file over the note byte ceiling opens read-only on desktop and no
        // task line in it was ever converted, so it carries none.
        const stat = await fs.stat(absolute).catch(() => null)
        if (!stat || classifyMarkdownStat(stat.size)) continue
        const markdown = await fs.readFile(absolute, 'utf-8').catch(() => null)
        if (!markdown) continue
        for (const taskId of scanTaskCheckboxStates(markdown).keys()) found.add(taskId)
      }
      if (found.size === 0) return { taskIds: [] }

      const existing = new Set(
        dataDb
          .select({ id: tasks.id })
          .from(tasks)
          .where(inArray(tasks.id, [...found]))
          .all()
          .map((row) => row.id)
      )
      const links = dataDb
        .select({ taskId: taskNotes.taskId, noteId: taskNotes.noteId })
        .from(taskNotes)
        .where(inArray(taskNotes.taskId, [...found]))
        .all()
      const outsideLinkedIds = new Set(
        links
          .filter((link) => !deleting.has(link.noteId) && getNoteMetadataById(dataDb, link.noteId))
          .map((link) => link.taskId)
      )
      // A task whose line is here but which is also linked to a note that
      // survives the delete still has a home, so it is left out.
      return {
        taskIds: [...found].filter(
          (taskId) => existing.has(taskId) && !outsideLinkedIds.has(taskId)
        )
      }
    },

    async positions(folderPath) {
      const rows =
        folderPath === undefined
          ? dataDb.select().from(notePositions).all()
          : dataDb
              .select()
              .from(notePositions)
              .where(eq(notePositions.folderPath, folderArg(folderPath)))
              .all()
      return { positions: Object.fromEntries(rows.map((row) => [row.path, row.position])) }
    },

    async reorder(folderPath, notePaths) {
      const folder = folderArg(folderPath)
      const normalized = notePaths.map((notePath) => normalizePath(notePath))
      for (const notePath of normalized) {
        if (!getNoteMetadataByPath(dataDb, notePath)) throw new Error(`Note not found: ${notePath}`)
        const parent = path.posix.dirname(notePath)
        if ((parent === '.' ? '' : parent) !== folder) {
          throw new Error(`Note is not in folder "${folder}": ${notePath}`)
        }
      }
      dataDb.transaction((tx) => {
        normalized.forEach((notePath, position) => {
          const existing = tx
            .select()
            .from(notePositions)
            .where(eq(notePositions.path, notePath))
            .get()
          if (existing) {
            tx.update(notePositions)
              .set({ folderPath: folder, position })
              .where(eq(notePositions.path, notePath))
              .run()
          } else {
            tx.insert(notePositions).values({ path: notePath, folderPath: folder, position }).run()
          }
        })
      })
      return { success: true }
    },

    // Same walk as desktop's getFolderTemplate: the nearest folder with a
    // template wins, and `inherit: false` stops the climb.
    async getFolderTemplate(folderPath) {
      const folder = folderArg(folderPath)
      let current = folder
      while (true) {
        const config = await readFolderTemplateOf(current)
        if (config.template) return { folder, template: config.template }
        if (!config.inherit || current === '') return { folder, template: null }
        const parent = path.posix.dirname(current)
        current = parent === '.' ? '' : parent
      }
    },

    async setFolderTemplate(folderPath, templateId) {
      const folder = folderArg(folderPath)
      if (templateId !== null && !(await templates.get(templateId))) {
        throw new Error(`Template not found: ${templateId}`)
      }
      const target = path.join(vaultPath, folder, '.folder.md')
      const raw = await fs.readFile(target, 'utf-8').catch(() => null)
      const parsed = parseMarkdownNote(raw ?? '')
      const frontmatter = { ...parsed.frontmatter }
      if (templateId) frontmatter.template = templateId
      else delete frontmatter.template
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(
        target,
        serializeParsedMarkdownNote(
          { ...parsed, frontmatter } as ParsedMarkdownNote,
          parsed.content,
          {
            frontmatterEdited: true
          }
        ),
        'utf-8'
      )
      return { folder, template: templateId }
    },

    async readLines(idOrPath, startLine, count) {
      if (!Number.isInteger(startLine) || startLine < 0) throw new Error('--from must be 0 or more')
      if (!Number.isInteger(count) || count < 1 || count > MAX_READ_LINES) {
        throw new Error(`--count must be between 1 and ${MAX_READ_LINES}`)
      }
      const absolute = resolveFile(idOrPath)
      await assertFile(absolute, idOrPath)

      const lines: string[] = []
      const truncated: number[] = []
      let line = 0
      let endOfFile = true
      for await (const text of iterateFileLines(absolute)) {
        if (line >= startLine) {
          if (lines.length === count) {
            endOfFile = false
            break
          }
          if (text.length > MAX_LINE_CHARS) {
            lines.push(text.slice(0, MAX_LINE_CHARS))
            truncated.push(line)
          } else {
            lines.push(text)
          }
        }
        line += 1
      }
      return { startLine, lines, truncated, endOfFile }
    },

    async grep(idOrPath, query) {
      if (!query || query.length > MAX_QUERY_LENGTH) {
        throw new Error(`Query must be 1 to ${MAX_QUERY_LENGTH} characters`)
      }
      if (/[\r\n]/.test(query)) throw new Error('Query cannot span lines')
      const absolute = resolveFile(idOrPath)
      await assertFile(absolute, idOrPath)

      // Literal, ASCII-case-insensitive, non-overlapping: the rule desktop's
      // in-file search applies, with hits addressed as a line plus an
      // occurrence on it.
      const fold = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase())
      const needle = fold(query)
      const hits: Array<{ line: number; ordinal: number }> = []
      let total = 0
      let line = 0
      for await (const text of iterateFileLines(absolute)) {
        const haystack = fold(text)
        let ordinal = 0
        let from = 0
        while (true) {
          const at = haystack.indexOf(needle, from)
          if (at < 0) break
          total += 1
          if (hits.length < MAX_SEARCH_HITS) hits.push({ line, ordinal })
          ordinal += 1
          from = at + needle.length
        }
        line += 1
      }
      return { status: 'complete', query, hits, total, limited: total > hits.length }
    }
  }
}
