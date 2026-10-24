import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, and } from 'drizzle-orm'
import { attachmentUploadQueue, noteMetadata } from '@memry/db-schema/data-schema'
import type { DataDb } from './database.ts'
import {
  attachmentEmbed,
  attachmentType,
  encodeAttachmentUrl,
  isAllowedAttachment,
  mimeType,
  noteRelativeRef,
  type AttachmentResult,
  type AttachmentsService
} from './note-files.ts'
import type { NotesService } from './notes.ts'
import { ATTACHMENTS_DIR, normalizePath, safeFilename } from './paths.ts'

export interface VaultAttachmentEntry {
  ownerNoteId: string
  ownerNoteTitle: string | null
  filename: string
  displayName: string
  size: number
  mimeType: string
  type: 'image' | 'file'
  modifiedAt: string
}

export interface AttachmentRenameResult {
  storedFilename: string
  url: string
  name: string
}

export interface AttachmentToolsService {
  rename(noteId: string, filename: string, newName: string): Promise<AttachmentRenameResult>
  listVault(): Promise<VaultAttachmentEntry[]>
  attachExisting(noteId: string, ownerNoteId: string, filename: string): Promise<AttachmentResult>
  attachUrl(noteId: string, url: string): Promise<AttachmentResult>
}

// Desktop stores `{6-char id}-{name}`; this CLI has stored `file_{12-char id}-{name}`.
// A rename keeps whichever prefix the file has.
const STORED_PREFIX_RE = /^(?:[0-9a-z]{6}|file_[\w-]{12})-/
const MAX_COLLISION_ATTEMPTS = 100
const MAX_REMOTE_BYTES = 25 * 1024 * 1024
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

function isPlainSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  )
}

/** The stored name minus its id prefix, which is the sanitized original name. */
function displayNameForStored(filename: string): string {
  return filename.replace(STORED_PREFIX_RE, '')
}

// Mirrors desktop's `sanitizeAttachmentName`: spaces, parens and braces break
// markdown image links and end the `<!-- file:{…} -->` marker early.
function sanitizeAttachmentName(requested: string): string {
  return (
    safeFilename(requested)
      .replace(/[\s(){}]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'file'
  )
}

// Mirrors desktop's `buildRenamedFilename`: the prefix and the extension stay,
// only the middle changes, and a typed extension equal to the current one is dropped.
function buildRenamedFilename(currentStored: string, requestedName: string): string {
  const ext = path.extname(currentStored)
  const prefix = currentStored.match(STORED_PREFIX_RE)?.[0] ?? ''
  let base = requestedName.trim()
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) {
    base = base.slice(0, base.length - ext.length)
  }
  return `${prefix}${sanitizeAttachmentName(base)}${ext}`
}

function resolveCollision(dir: string, candidate: string): string {
  if (!existsSync(path.join(dir, candidate))) return candidate
  const ext = path.extname(candidate)
  const base = candidate.slice(0, candidate.length - ext.length)
  for (let n = 2; n < MAX_COLLISION_ATTEMPTS; n++) {
    const next = `${base}-${n}${ext}`
    if (!existsSync(path.join(dir, next))) return next
  }
  throw new Error('Could not find a free attachment filename')
}

function displayNameFor(storedFilename: string, requested: string): string {
  const ext = path.extname(storedFilename)
  const trimmed = requested.trim()
  if (!ext || trimmed.toLowerCase().endsWith(ext.toLowerCase())) return trimmed
  return `${trimmed}${ext}`
}

function remoteFilename(url: string, extensionName: string): string {
  let candidate = ''
  try {
    candidate = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    candidate = ''
  }
  const base = candidate
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base.slice(0, 64) || 'linked-image'}.${extensionName}`
}

export function createAttachmentToolsService({
  vaultPath,
  dataDb,
  notes,
  attachments
}: {
  vaultPath: string
  dataDb: DataDb
  notes: NotesService
  attachments: AttachmentsService
}): AttachmentToolsService {
  async function requireNote(idOrPath: string) {
    const note = await notes.get(idOrPath)
    if (!note) throw new Error(`Note not found: ${idOrPath}`)
    return note
  }

  return {
    async rename(noteId, filename, newName) {
      const note = await requireNote(noteId)
      const trimmed = newName.trim()
      if (!trimmed) throw new Error('New attachment name is empty')
      const current = path.basename(filename)
      if (!isPlainSegment(current)) throw new Error('Invalid attachment filename')

      // Only files this note owns are renameable: a file under another note's
      // folder has references this note cannot rewrite.
      const dir = path.join(vaultPath, ATTACHMENTS_DIR, note.id)
      if (!existsSync(path.join(dir, current))) {
        throw new Error(`Attachment not found for note ${note.id}: ${current}`)
      }

      const candidate = buildRenamedFilename(current, trimmed)
      const target = candidate === current ? candidate : resolveCollision(dir, candidate)
      const display = displayNameFor(target, trimmed)
      const relativeTarget = normalizePath(path.join(ATTACHMENTS_DIR, note.id, target))
      const ref = noteRelativeRef(note.path, relativeTarget)
      if (target === current) return { storedFilename: target, url: ref, name: display }

      // Disk first, body second: a crash in between leaves a body naming the old
      // file (which prefix self-heal repairs), never one naming a file that exists nowhere.
      await fs.rename(path.join(dir, current), path.join(dir, target))
      const oldPart = `${ATTACHMENTS_DIR}/${note.id}/${current}`
      const newPart = `${ATTACHMENTS_DIR}/${note.id}/${target}`
      let content = note.content
        .split(oldPart)
        .join(newPart)
        .split(encodeAttachmentUrl(oldPart))
        .join(encodeAttachmentUrl(newPart))
      content = content.replace(/<!-- file:(\{.*?\}) -->/g, (marker, json: string) => {
        try {
          const props = JSON.parse(json) as Record<string, unknown>
          if (typeof props.url !== 'string' || !props.url.endsWith(newPart)) return marker
          return `<!-- file:${JSON.stringify({ ...props, name: display.replace(/[{}]/g, '') })} -->`
        } catch {
          return marker
        }
      })
      if (content !== note.content) await notes.update({ id: note.id, content })

      // A queued upload is keyed by disk path, so it follows the file.
      dataDb
        .update(attachmentUploadQueue)
        .set({ diskPath: path.join(dir, target), updatedAt: Date.now() })
        .where(
          and(
            eq(attachmentUploadQueue.noteId, note.id),
            eq(attachmentUploadQueue.diskPath, path.join(dir, current))
          )
        )
        .run()
      return { storedFilename: target, url: ref, name: display }
    },

    // The folder is the source of truth for what exists on this device, so this
    // walks `attachments/` rather than any table. Folders whose note is gone are
    // still listed: the bytes are real.
    async listVault() {
      const root = path.join(vaultPath, ATTACHMENTS_DIR)
      const owners = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
      const titles = new Map(
        dataDb
          .select({ id: noteMetadata.id, title: noteMetadata.title })
          .from(noteMetadata)
          .all()
          .map((row) => [row.id, row.title])
      )
      const entries: VaultAttachmentEntry[] = []
      for (const owner of owners) {
        if (!owner.isDirectory() || owner.name.startsWith('.')) continue
        const dir = path.join(root, owner.name)
        for (const file of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (!file.isFile() || file.name.startsWith('.') || !isAllowedAttachment(file.name))
            continue
          const stats = await fs.stat(path.join(dir, file.name)).catch(() => null)
          if (!stats) continue
          entries.push({
            ownerNoteId: owner.name,
            ownerNoteTitle: titles.get(owner.name) ?? null,
            filename: file.name,
            displayName: displayNameForStored(file.name),
            size: stats.size,
            mimeType: mimeType(file.name),
            type: attachmentType(file.name),
            modifiedAt: stats.mtime.toISOString()
          })
        }
      }
      return entries.toSorted((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    },

    // Embeds an attachment another note already stores. Nothing is copied or
    // uploaded: the ref is the relationship, and the owner's sync carries the bytes.
    async attachExisting(noteId, ownerNoteId, filename) {
      const note = await requireNote(noteId)
      if (!isPlainSegment(ownerNoteId) || !isPlainSegment(filename)) {
        throw new Error('Invalid attachment reference')
      }
      const absolutePath = path.join(vaultPath, ATTACHMENTS_DIR, ownerNoteId, filename)
      const stats = await fs.stat(absolutePath).catch(() => null)
      if (!stats?.isFile()) throw new Error('Attachment file not found on disk')

      const relativePath = normalizePath(path.join(ATTACHMENTS_DIR, ownerNoteId, filename))
      const result: AttachmentResult = {
        success: true,
        path: relativePath,
        absolutePath,
        filename,
        name: displayNameForStored(filename),
        size: stats.size,
        mimeType: mimeType(filename),
        type: attachmentType(filename)
      }
      const ref = noteRelativeRef(note.path, relativePath)
      await notes.update({ id: note.id, append: attachmentEmbed(ref, result) })
      return { ...result, ref }
    },

    // Copies a public image into the note's own attachments folder, so it keeps
    // working offline and after the page behind the link goes away.
    async attachUrl(noteId, url) {
      await requireNote(noteId)
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(`Invalid URL: ${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http and https URLs can be attached')
      }
      let response: Response
      try {
        response = await fetch(parsed)
      } catch (error) {
        throw new Error(
          `Could not fetch ${url}: ${error instanceof Error ? error.message : error}`,
          {
            cause: error
          }
        )
      }
      if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}`)
      // A page that shows a photo answers with HTML; refusing on the declared
      // type keeps that out of the vault.
      const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      const ext = declared ? EXTENSION_BY_MIME[declared] : undefined
      if (!ext) throw new Error('The URL is not an image (jpeg, png, webp or gif)')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength > MAX_REMOTE_BYTES) throw new Error('Image is too large (25 MB max)')

      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-attach-'))
      try {
        const file = path.join(dir, remoteFilename(url, ext))
        await fs.writeFile(file, bytes)
        return await attachments.add(noteId, file)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
  }
}
