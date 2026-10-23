import path from 'node:path'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'
import {
  calendarEvents,
  noteMetadata,
  projectLinks,
  projects,
  type ProjectLink
} from '@memry/db-schema/data-schema'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import { createId } from '@memry/app-core/ids'
import { getNoteMetadataByPath } from '@memry/storage-data'
import type { DataDb } from './database.ts'
import type { ImportFilesInput, ImportFilesResult } from './note-files.ts'
import type { NotesService } from './notes.ts'
import type { PropertiesService } from './properties.ts'
import { normalizePath } from './paths.ts'

export type ProjectLinkItemType = 'note' | 'calendar_event' | 'file'

export interface ProjectLinkInput {
  projectId: string
  itemType: ProjectLinkItemType
  itemId: string
}

export interface ProjectRef {
  id: string
  name: string
  color: string
  icon: string | null
}

export interface ProjectLinkedNote {
  id: string
  title: string
  emoji: string | null
  modifiedAt: string
  pinned: boolean
}

export interface ProjectLinkedFile {
  id: string
  title: string
  fileType: string
  mimeType: string | null
  fileSize: number | null
  modifiedAt: string
}

export interface ProjectLinkedEvent {
  id: string
  title: string
  startAt: string
  endAt: string | null
  isAllDay: boolean
}

export interface ProjectContents {
  notes: ProjectLinkedNote[]
  files: ProjectLinkedFile[]
  events: ProjectLinkedEvent[]
  counts: { notes: number; files: number; events: number }
}

export interface ProjectLinkResult {
  success: boolean
  error?: string
}

export interface CaptureUrlResult {
  success: boolean
  noteId?: string
  error?: string
}

export interface ImportToProjectResult {
  success: boolean
  linked: string[]
  failed: { path: string; error: string }[]
}

export interface ProjectLinksService {
  link(input: ProjectLinkInput, options?: { pinned?: boolean }): Promise<ProjectLinkResult>
  unlink(input: ProjectLinkInput): Promise<ProjectLinkResult>
  list(projectId: string): Promise<ProjectLink[]>
  forItem(itemType: ProjectLinkItemType, itemId: string): Promise<ProjectRef[]>
  contents(projectId: string): Promise<ProjectContents>
  setPinned(projectId: string, itemId: string, pinned: boolean): Promise<ProjectLinkResult>
  setHomeNote(
    projectId: string,
    noteId: string | null
  ): Promise<ProjectLinkResult & { homeNoteId?: string | null }>
  captureUrl(projectId: string, url: string): Promise<CaptureUrlResult>
  importFiles(
    projectId: string,
    sourcePaths: string[],
    targetFolder?: string
  ): Promise<ImportToProjectResult>
}

// --- `project` frontmatter helpers. Mirrors apps/desktop/src/main/notes/project-property.ts;
// project-links.test.ts holds the two to the same behavior.

function toEntryList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw === null || raw === undefined || raw === '') return []
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Not JSON after all: a literal name.
      }
    }
  }
  return [raw]
}

export function readProjectNames(properties: Record<string, unknown>): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const entry of toEntryList(properties[PROJECT_PROPERTY_KEY])) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

export function withProjectName(names: string[], name: string): string[] {
  return names.some((n) => n.toLowerCase() === name.toLowerCase()) ? names : [...names, name]
}

export function withoutProjectName(names: string[], name: string): string[] {
  return names.filter((n) => n.toLowerCase() !== name.toLowerCase())
}

// --- Capture URL. Mirrors apps/desktop/src/main/tasks/capture-url.ts.

export function titleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
    return `${parsed.host}${pathname}`
  } catch {
    return url
  }
}

function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1')
}

function markdownDestination(url: string): string {
  if (!/[\s()<>]/.test(url)) return url
  return `<${url.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
}

export function urlCaptureNote(
  url: string,
  title: string | null
): { title: string; content: string } {
  const linkText = title?.trim() || url
  return {
    title: title?.trim() || titleFromUrl(url),
    content: `[${escapeLinkText(linkText)}](${markdownDestination(url)})\n`
  }
}

const TITLE_FETCH_TIMEOUT_MS = 5000

/** A missing title (offline, a 404, a blocking site) is normal and never fails a capture. */
async function fetchPageTitle(url: string): Promise<string | null> {
  try {
    const protocol = new URL(url).protocol
    if (protocol !== 'http:' && protocol !== 'https:') return null
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TITLE_FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html' }
    })
    if (!response.ok) return null
    const html = (await response.text()).slice(0, 200_000)
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
    const title = match?.[1]?.replace(/\s+/g, ' ').trim()
    return title || null
  } catch {
    return null
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export function createProjectLinksService({
  dataDb,
  notes,
  properties,
  importFiles,
  vaultPath,
  fetchTitle = fetchPageTitle
}: {
  dataDb: DataDb
  notes: NotesService
  properties: PropertiesService
  importFiles: (input: ImportFilesInput) => Promise<ImportFilesResult>
  vaultPath: string
  fetchTitle?: (url: string) => Promise<string | null>
}): ProjectLinksService {
  // The project payload carries its links and home note, so every write here owes
  // the server a project update. Desktop turns the intent into a queue row at its
  // next sync runtime start or pull.
  const owePush = (projectId: string, changedFields: string[]): void => {
    dataDb
      .insert(syncIntents)
      .values({
        type: 'project',
        itemId: projectId,
        op: 'update',
        args: JSON.stringify([changedFields]),
        createdAt: new Date()
      })
      .run()
  }

  const touchProject = (projectId: string): void => {
    dataDb.update(projects).set({ modifiedAt: nowIso() }).where(eq(projects.id, projectId)).run()
  }

  const getProject = (projectId: string) =>
    dataDb.select().from(projects).where(eq(projects.id, projectId)).get()

  const isMarkdownNote = (itemId: string): boolean =>
    dataDb
      .select({ fileType: noteMetadata.fileType })
      .from(noteMetadata)
      .where(eq(noteMetadata.id, itemId))
      .get()?.fileType === 'markdown'

  const findLink = (projectId: string, itemType: string, itemId: string) =>
    dataDb
      .select()
      .from(projectLinks)
      .where(
        and(
          eq(projectLinks.projectId, projectId),
          eq(projectLinks.itemType, itemType),
          eq(projectLinks.itemId, itemId)
        )
      )
      .get()

  const insertLink = (input: ProjectLinkInput): void => {
    if (findLink(input.projectId, input.itemType, input.itemId)) return
    dataDb
      .insert(projectLinks)
      .values({
        id: createId('plink'),
        projectId: input.projectId,
        itemType: input.itemType,
        itemId: input.itemId
      })
      .run()
  }

  // A markdown note's membership lives in its frontmatter and desktop's projector
  // derives the link row from it, so the frontmatter is the write. The row is
  // inserted too so CLI reads agree before desktop next indexes; it is the row the
  // projector would derive.
  const writeNoteNames = async (
    noteId: string,
    next: (names: string[]) => string[]
  ): Promise<ProjectLinkResult> => {
    let current: Record<string, unknown>
    try {
      current = await properties.get(noteId)
    } catch {
      return { success: false, error: 'Entity not found' }
    }
    await properties.set(noteId, {
      ...current,
      [PROJECT_PROPERTY_KEY]: next(readProjectNames(current))
    })
    return { success: true }
  }

  return {
    async link(input, options) {
      const project = getProject(input.projectId)
      if (!project) return { success: false, error: 'Project not found' }

      if (input.itemType === 'calendar_event') {
        const event = dataDb
          .select({ id: calendarEvents.id })
          .from(calendarEvents)
          .where(eq(calendarEvents.id, input.itemId))
          .get()
        if (!event) return { success: false, error: 'Calendar event not found' }
      } else if (
        !dataDb
          .select({ id: noteMetadata.id })
          .from(noteMetadata)
          .where(eq(noteMetadata.id, input.itemId))
          .get()
      ) {
        return { success: false, error: `${input.itemType === 'file' ? 'File' : 'Note'} not found` }
      }

      if (isMarkdownNote(input.itemId)) {
        const written = await writeNoteNames(input.itemId, (names) =>
          withProjectName(names, project.name)
        )
        if (!written.success) return written
        // The projector keys a frontmatter link by note id, whatever item_type says.
        insertLink({ ...input, itemType: 'note' })
      } else {
        insertLink(input)
        owePush(input.projectId, ['links'])
        touchProject(input.projectId)
      }

      if (options?.pinned) {
        dataDb
          .update(projectLinks)
          .set({ pinned: 1 })
          .where(
            and(eq(projectLinks.projectId, input.projectId), eq(projectLinks.itemId, input.itemId))
          )
          .run()
      }
      return { success: true }
    },

    async unlink(input) {
      const project = getProject(input.projectId)
      if (!project) return { success: false, error: 'Project not found' }

      const frontmatterOwned = isMarkdownNote(input.itemId)
      if (frontmatterOwned) {
        const written = await writeNoteNames(input.itemId, (names) =>
          withoutProjectName(names, project.name)
        )
        if (!written.success) return written
      }
      dataDb
        .delete(projectLinks)
        .where(
          and(
            eq(projectLinks.projectId, input.projectId),
            eq(projectLinks.itemId, input.itemId),
            // A frontmatter-owned row is matched without item_type, like desktop's projector.
            ...(frontmatterOwned ? [] : [eq(projectLinks.itemType, input.itemType)])
          )
        )
        .run()
      if (!frontmatterOwned) {
        owePush(input.projectId, ['links'])
        touchProject(input.projectId)
      }
      return { success: true }
    },

    async list(projectId) {
      return dataDb
        .select()
        .from(projectLinks)
        .where(eq(projectLinks.projectId, projectId))
        .orderBy(asc(projectLinks.position), asc(projectLinks.createdAt))
        .all()
    },

    async forItem(itemType, itemId) {
      return dataDb
        .select({
          id: projects.id,
          name: projects.name,
          color: projects.color,
          icon: projects.icon
        })
        .from(projectLinks)
        .innerJoin(projects, eq(projectLinks.projectId, projects.id))
        .where(and(eq(projectLinks.itemType, itemType), eq(projectLinks.itemId, itemId)))
        .orderBy(asc(projectLinks.createdAt), asc(projectLinks.id))
        .all()
    },

    // Mirrors getProjectContents: inner joins drop links whose note or event is gone.
    // `file_type`, not `item_type`, decides notes versus files.
    async contents(projectId) {
      const noteRows = dataDb
        .select({
          id: noteMetadata.id,
          title: noteMetadata.title,
          emoji: noteMetadata.emoji,
          fileType: noteMetadata.fileType,
          mimeType: noteMetadata.mimeType,
          fileSize: noteMetadata.fileSize,
          modifiedAt: noteMetadata.modifiedAt,
          pinned: projectLinks.pinned
        })
        .from(projectLinks)
        .innerJoin(noteMetadata, eq(noteMetadata.id, projectLinks.itemId))
        .where(
          and(
            eq(projectLinks.projectId, projectId),
            inArray(projectLinks.itemType, ['note', 'file'])
          )
        )
        .orderBy(asc(projectLinks.position), asc(noteMetadata.title))
        .all()

      const eventRows = dataDb
        .select({
          id: calendarEvents.id,
          title: calendarEvents.title,
          startAt: calendarEvents.startAt,
          endAt: calendarEvents.endAt,
          isAllDay: calendarEvents.isAllDay
        })
        .from(projectLinks)
        .innerJoin(calendarEvents, eq(calendarEvents.id, projectLinks.itemId))
        .where(
          and(eq(projectLinks.projectId, projectId), eq(projectLinks.itemType, 'calendar_event'))
        )
        .orderBy(asc(calendarEvents.startAt))
        .all()

      const noteItems: ProjectLinkedNote[] = noteRows
        .filter((row) => row.fileType === 'markdown')
        .map((row) => ({
          id: row.id,
          title: row.title,
          emoji: row.emoji,
          modifiedAt: row.modifiedAt,
          pinned: row.pinned === 1
        }))
      const files: ProjectLinkedFile[] = noteRows
        .filter((row) => row.fileType !== 'markdown')
        .map((row) => ({
          id: row.id,
          title: row.title,
          fileType: row.fileType,
          mimeType: row.mimeType,
          fileSize: row.fileSize,
          modifiedAt: row.modifiedAt
        }))
      const events: ProjectLinkedEvent[] = eventRows.map((row) => ({
        id: row.id,
        title: row.title,
        startAt: row.startAt,
        endAt: row.endAt,
        isAllDay: Boolean(row.isAllDay)
      }))
      return {
        notes: noteItems,
        files,
        events,
        counts: { notes: noteItems.length, files: files.length, events: events.length }
      }
    },

    async setPinned(projectId, itemId, pinned) {
      if (!getProject(projectId)) return { success: false, error: 'Project not found' }
      dataDb
        .update(projectLinks)
        .set({ pinned: pinned ? 1 : 0 })
        .where(and(eq(projectLinks.projectId, projectId), eq(projectLinks.itemId, itemId)))
        .run()
      touchProject(projectId)
      owePush(projectId, ['links'])
      return { success: true }
    },

    async setHomeNote(projectId, noteId) {
      if (!getProject(projectId)) return { success: false, error: 'Project not found' }
      if (noteId !== null && !isMarkdownNote(noteId)) {
        return { success: false, error: `Note not found: ${noteId}` }
      }
      dataDb
        .update(projects)
        .set({ homeNoteId: noteId, modifiedAt: nowIso() })
        .where(eq(projects.id, projectId))
        .run()
      owePush(projectId, ['homeNoteId'])
      return { success: true, homeNoteId: noteId }
    },

    async captureUrl(projectId, url) {
      if (!getProject(projectId)) return { success: false, error: 'Project not found' }
      const captured = urlCaptureNote(url, await fetchTitle(url))
      const note = await notes.create(captured)
      const linked = await this.link({ projectId, itemType: 'note', itemId: note.id })
      // A note that never joined the project is a failed capture, not a quiet success.
      if (!linked.success) {
        return { success: false, noteId: note.id, error: linked.error ?? 'Failed to link note' }
      }
      return { success: true, noteId: note.id }
    },

    async importFiles(projectId, sourcePaths, targetFolder) {
      if (!getProject(projectId)) {
        return {
          success: false,
          linked: [],
          failed: [{ path: '', error: 'Project not found' }]
        }
      }
      const imported = await importFiles({ sourcePaths, targetFolder })
      const linked: string[] = []
      const failed = imported.errors.map((error) => ({ path: '', error }))

      for (const file of imported.importedFiles) {
        const relative = normalizePath(path.relative(vaultPath, file.destPath))
        const id = getNoteMetadataByPath(dataDb, relative)?.id ?? null
        if (!id) {
          // Only markdown is indexed on import; desktop's indexer assigns the id to
          // every other file after it opens the vault.
          failed.push({
            path: file.destPath,
            error:
              'File was imported but has no id yet. Open Memry so it indexes the file, then run `projects link <project> --file <id>`.'
          })
          continue
        }
        const result = await this.link({
          projectId,
          itemType: file.fileType === 'markdown' ? 'note' : 'file',
          itemId: id
        })
        if (result.success) linked.push(id)
        else failed.push({ path: file.destPath, error: result.error ?? 'Failed to link file' })
      }
      return { success: failed.length === 0, linked, failed }
    }
  }
}
