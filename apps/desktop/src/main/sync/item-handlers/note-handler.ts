import fs from 'fs'
import path from 'path'
import { NoteSyncPayloadSchema, type NoteSyncPayload } from '@memry/contracts/sync-payloads'
import { utcNow } from '@memry/shared/utc'
import {
  isBinaryFileType,
  getExtensionFromMimeType,
  getDefaultExtension,
  getMimeType,
  type FileType
} from '@memry/shared/file-types'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { extractFolderFromPath } from '../note-sync'
import { markWritebackIgnored } from '../crdt-writeback'
import { emitNoteUpdated } from '@memry/sync-client/note-events'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import {
  markDownloadRequested,
  pruneUnresolvableReferences,
  releaseDownloadAttempt,
  shouldAttemptDownload
} from '@memry/sync-client/attachment-download-state'
import { getIndexDatabase } from '../../database/client'
import {
  deleteFile,
  generateNotePath,
  generateFilePath,
  generateUniquePathSync
} from '../../vault/file-ops'
import { toAbsolutePath, toRelativePath, getVaultRoot } from '../../vault/notes'
import { getNoteAttachmentsDir } from '../../vault/attachments'
import { getStatus as getVaultStatus } from '../../vault/index'
import {
  parseNote,
  serializeNote,
  serializeParsedNote,
  extractInlineTagsFromMarkdown,
  inferPropertyType,
  resolvePropertyType,
  type NoteFrontmatter
} from '../../vault/frontmatter'
import { isPersistableDefinitionType, type PropertyType } from '@memry/contracts/property-types'
import { syncNoteToCache, syncFileToCache, deleteNoteFromCache } from '../../vault/note-sync'
import { cleanupProjectLinksForDeletedNote } from '../../notes/runtime-effects'
import { flushProjectionEvents } from '../../projections'
import { reconcileNoteLinks } from '../../projections/projectors/note-project-links-projector'
import { isMarkdownNote } from '../../database/queries/projects'
import {
  getNoteMetadataById,
  updateNoteMetadata,
  getPropertyDefinition as getCanonicalPropertyDefinition
} from '@memry/storage-data'
import { saveCanonicalPropertyDefinition } from '@memry/domain-notes'
import {
  getNoteCacheByPath,
  getNoteTags,
  setNoteTags,
  updateNoteCache,
  setNoteProperties
} from '@main/database/queries/notes'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from '@memry/sync-client/item-handlers/base-handler'
import { applyPinnedTags } from '@memry/sync-client/item-handlers/note-pin-helpers'
import {
  buildNotePushPayload,
  fetchLocalNote,
  seedUnclockedNotes
} from './note-handler-sync-helpers'
import type { ApplyContext, ApplyResult, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('NoteHandler')

async function removeEmptyParents(dir: string, stopAt: string): Promise<void> {
  let current = dir
  while (current !== stopAt && current.startsWith(stopAt)) {
    try {
      const entries = await fs.promises.readdir(current)
      const meaningful = entries.filter((e) => e !== '.DS_Store' && !e.startsWith('._'))
      if (meaningful.length > 0) break

      for (const junk of entries) {
        await fs.promises.unlink(path.join(current, junk)).catch(() => {})
      }
      await fs.promises.rmdir(current)
      log.debug('Removed empty folder', { dir: current })
      current = path.dirname(current)
    } catch {
      break
    }
  }
}

/**
 * Remote frontmatter tags ∪ the body `#hashtags` of this device's copy of the
 * note, merged case-insensitively with the frontmatter spelling winning — the
 * same merge `extractNoteMetadata` performs when indexing a note from disk.
 *
 * A push payload carries frontmatter tags only, so a tag that exists solely as
 * a body hashtag never leaves the sending device. Re-deriving that half here is
 * what keeps the receiving side's replace from wiping it out of the index; the
 * body is the same on both devices, so nothing has to be asked of the sender —
 * and nothing body-derived leaks back into frontmatter (#1471).
 */
function mergeWithLocalBodyTags(remoteTags: string[], relPath: string): string[] {
  let bodyTags: string[]
  try {
    const parsed = parseNote(fs.readFileSync(toAbsolutePath(relPath), 'utf-8'))
    bodyTags = extractInlineTagsFromMarkdown(parsed.content)
  } catch {
    log.warn('Could not read note body to merge its inline tags', { path: relPath })
    return remoteTags
  }

  const byKey = new Map<string, string>()
  for (const tag of [...remoteTags, ...bodyTags]) {
    const key = tag.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, tag)
  }
  return [...byKey.values()]
}

function mergeAttachmentReferences(
  local: string[] | null | undefined,
  remote: string[] | null | undefined
): string[] | undefined {
  if (!remote?.length) return undefined
  const merged = [...(local ?? [])]
  for (const id of remote) {
    if (!merged.includes(id)) merged.push(id)
  }
  return merged
}

/**
 * Fetch server-side attachment blobs this note embeds. The note's markdown
 * references files under `attachments/<noteId>/…` which only exist on the
 * device that inserted them — every other device must materialize them from
 * the encrypted blob store into its own vault.
 */
function requestEmbeddedAttachmentDownloads(
  db: DrizzleDb,
  itemId: string,
  refs: string[] | null | undefined
): void {
  if (!refs?.length) return
  const vaultPath = getVaultStatus().path
  if (!vaultPath) return
  const attachmentsDir = getNoteAttachmentsDir(vaultPath, itemId)
  for (const attachmentId of refs) {
    // Skips what is already in flight, what already downloaded this session,
    // and what the server has answered 404 for — that last one persisted, so a
    // sync stop/start or a relaunch no longer replays the dead request.
    if (!shouldAttemptDownload(db, itemId, attachmentId)) continue
    markDownloadRequested(itemId, attachmentId)
    const delivered = attachmentEvents.emitDownloadNeeded({
      noteId: itemId,
      attachmentId,
      diskPath: attachmentsDir,
      intoDir: true
    })
    // `unregisterAttachmentHandlers()` removes every 'download-needed' listener
    // on sync-runtime restart, sign-out/in and token churn, so a dropped emit
    // has no downloader to report an outcome. Release the claim immediately or
    // the attachment is never asked for again for the life of the process.
    if (!delivered) releaseDownloadAttempt(itemId, attachmentId)
  }
}

class NoteHandler extends BaseItemHandler<NoteSyncPayload> {
  readonly type = 'note' as const
  readonly schema = NoteSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: NoteSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    const indexDb = getIndexDatabase()
    const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
    const now = utcNow()

    const existing = getNoteMetadataById(ctx.db, itemId)

    if (existing) {
      const resolution = this.resolveClock(existing.clock, remoteClock)
      if (resolution.action === 'skip') {
        log.info('Skipping remote note update, local is newer', { itemId })
        return 'skipped'
      }
      if (resolution.action === 'merge') {
        log.warn('Concurrent note edit, applying (CRDT handles merge)', { itemId })
      }

      if (existing.fileType && isBinaryFileType(existing.fileType)) {
        const newTitle = data.title ?? existing.title
        const titleChanged = newTitle !== existing.title
        const localFolder = extractFolderFromPath(existing.path)
        const remoteFolder = data.folderPath ?? null
        const folderChanged = localFolder !== remoteFolder
        const resolvedEmoji = data.emoji ?? existing.emoji
        const needsPathUpdate = folderChanged || titleChanged

        const updateFields: Parameters<typeof updateNoteCache>[2] = {
          title: newTitle,
          emoji: resolvedEmoji,
          clock: resolution.mergedClock,
          syncedAt: now,
          modifiedAt: data.modifiedAt ?? now
        }

        if (needsPathUpdate) {
          const notesDir = getVaultRoot()
          const ext = existing.mimeType
            ? (getExtensionFromMimeType(existing.mimeType) ??
              getDefaultExtension(existing.fileType))
            : getDefaultExtension(existing.fileType)
          // Folder-only move (title unchanged): preserve the existing on-disk
          // basename byte-for-byte instead of re-deriving it through the
          // sanitizer, which would retroactively rename legacy files.
          const baseAbsPath = titleChanged
            ? generateFilePath(notesDir, newTitle, ext, remoteFolder ?? undefined)
            : path.join(notesDir, remoteFolder ?? '', path.basename(existing.path))
          const newAbsPath = generateUniquePathSync(
            baseAbsPath,
            (p) => !!getNoteCacheByPath(indexDb, toRelativePath(p))
          )
          const newRelPath = toRelativePath(newAbsPath)
          const oldAbsPath = toAbsolutePath(existing.path)

          updateFields.path = newRelPath

          try {
            if (fs.existsSync(oldAbsPath)) {
              markWritebackIgnored(newAbsPath)
              const dir = path.dirname(newAbsPath)
              fs.mkdirSync(dir, { recursive: true })
              fs.renameSync(oldAbsPath, newAbsPath)
              removeEmptyParents(path.dirname(oldAbsPath), notesDir).catch(() => {})
            }
          } catch {
            log.warn('Could not rename binary file', { itemId })
          }

          if (titleChanged) {
            ctx.emit(NotesChannels.events.RENAMED, {
              id: itemId,
              oldPath: existing.path,
              newPath: newRelPath,
              oldTitle: existing.title,
              newTitle,
              source: 'sync'
            })
          }
          if (folderChanged) {
            ctx.emit(NotesChannels.events.MOVED, {
              id: itemId,
              oldPath: existing.path,
              newPath: newRelPath,
              source: 'sync'
            })
          }
        }

        updateNoteCache(indexDb, itemId, updateFields)
        updateNoteMetadata(ctx.db, itemId, {
          path: updateFields.path ?? existing.path,
          title: newTitle,
          emoji: resolvedEmoji,
          fileType: existing.fileType,
          mimeType: existing.mimeType,
          fileSize: existing.fileSize,
          attachmentId: data.attachmentId ?? existing.attachmentId,
          clock: resolution.mergedClock,
          syncedAt: now,
          modifiedAt: data.modifiedAt ?? now
        })
        // Binary/file branch: only sidecar metadata moved, never file bytes.
        emitNoteUpdated(ctx.emit, {
          id: itemId,
          changes: { title: newTitle, emoji: resolvedEmoji },
          source: 'sync'
        })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      const localFolder = extractFolderFromPath(existing.path)
      const remoteFolder = data.folderPath ?? null
      const folderChanged = localFolder !== remoteFolder
      const newTitle = data.title ?? existing.title
      const titleChanged = newTitle !== existing.title
      const needsPathUpdate = folderChanged || titleChanged

      const remoteTags = data.tags
      const localTags = remoteTags !== undefined ? getNoteTags(indexDb, itemId) : undefined
      const tagsChanged =
        remoteTags !== undefined &&
        localTags !== undefined &&
        (remoteTags.length !== localTags.length || remoteTags.some((t) => !localTags.includes(t)))

      const remoteProperties = data.properties
      const propertiesPresent = remoteProperties !== undefined && remoteProperties !== null

      log.debug('applyUpsert properties', {
        itemId,
        propertiesPresent,
        remotePropertiesKeys: remoteProperties ? Object.keys(remoteProperties) : 'undefined',
        action: resolution.action
      })

      const resolvedEmoji = data.emoji ?? existing.emoji

      const updateFields: Parameters<typeof updateNoteCache>[2] = {
        title: newTitle,
        emoji: resolvedEmoji,
        clock: resolution.mergedClock,
        syncedAt: now,
        modifiedAt: data.modifiedAt ?? now
      }

      if (needsPathUpdate) {
        const notesDir = getVaultRoot()
        // Folder-only move (title unchanged): preserve the existing on-disk
        // basename byte-for-byte instead of re-deriving it through the
        // sanitizer, which would retroactively rename legacy files.
        const baseAbsPath = titleChanged
          ? generateNotePath(notesDir, newTitle, remoteFolder ?? undefined)
          : path.join(notesDir, remoteFolder ?? '', path.basename(existing.path))
        const newAbsPath = generateUniquePathSync(
          baseAbsPath,
          (p) => !!getNoteCacheByPath(indexDb, toRelativePath(p))
        )
        const newRelPath = toRelativePath(newAbsPath)
        const oldAbsPath = toAbsolutePath(existing.path)

        updateFields.path = newRelPath

        try {
          markWritebackIgnored(newAbsPath)
          const dir = path.dirname(newAbsPath)
          fs.mkdirSync(dir, { recursive: true })

          if ((tagsChanged && remoteTags) || propertiesPresent) {
            // Content actually changed — rewrite user keys only
            const raw = fs.readFileSync(oldAbsPath, 'utf-8')
            const parsed = parseNote(raw)
            if (tagsChanged && remoteTags) {
              if (remoteTags.length > 0) {
                parsed.frontmatter.tags = remoteTags
              } else {
                delete parsed.frontmatter.tags
              }
            }
            if (propertiesPresent) {
              if (Object.keys(remoteProperties).length > 0) {
                parsed.frontmatter.properties = remoteProperties
              } else {
                delete parsed.frontmatter.properties
              }
            }
            const updatedContent = serializeParsedNote(parsed, parsed.content, {
              frontmatterEdited: true
            })
            const tmpPath = newAbsPath + '.tmp'
            fs.writeFileSync(tmpPath, updatedContent, 'utf-8')
            fs.renameSync(tmpPath, newAbsPath)
            fs.unlinkSync(oldAbsPath)
          } else {
            // Pure rename/move — file bytes untouched
            fs.renameSync(oldAbsPath, newAbsPath)
          }
          removeEmptyParents(path.dirname(oldAbsPath), notesDir).catch(() => {})
        } catch {
          log.warn('Could not read old note for rename/move', { itemId })
        }

        if (titleChanged) {
          ctx.emit(NotesChannels.events.RENAMED, {
            id: itemId,
            oldPath: existing.path,
            newPath: newRelPath,
            oldTitle: existing.title,
            newTitle,
            source: 'sync'
          })
        }
        if (folderChanged) {
          ctx.emit(NotesChannels.events.MOVED, {
            id: itemId,
            oldPath: existing.path,
            newPath: newRelPath,
            source: 'sync'
          })
        }
      } else if ((tagsChanged && remoteTags) || propertiesPresent) {
        // emoji is sidecar-only state — never a reason to rewrite the file
        const absPath = toAbsolutePath(existing.path)
        try {
          const raw = fs.readFileSync(absPath, 'utf-8')
          const parsed = parseNote(raw)
          if (tagsChanged && remoteTags) {
            if (remoteTags.length > 0) {
              parsed.frontmatter.tags = remoteTags
            } else {
              delete parsed.frontmatter.tags
            }
          }
          if (propertiesPresent) {
            if (Object.keys(remoteProperties).length > 0) {
              parsed.frontmatter.properties = remoteProperties
            } else {
              delete parsed.frontmatter.properties
            }
          }
          const updatedContent = serializeParsedNote(parsed, parsed.content, {
            frontmatterEdited: true
          })
          if (updatedContent !== raw) {
            markWritebackIgnored(absPath)
            const tmpPath = absPath + '.tmp'
            fs.writeFileSync(tmpPath, updatedContent, 'utf-8')
            fs.renameSync(tmpPath, absPath)
          }
        } catch {
          log.warn('Could not read note for frontmatter update', { itemId })
        }
      }

      // The index holds frontmatter ∪ body tags, but the payload only ever
      // carries the sender's frontmatter half, and `setNoteTags` replaces.
      // Re-derive the body half from the file (already at its new path if this
      // update moved it) so a body-only `#hashtag` survives a remote update.
      const indexTags =
        tagsChanged && remoteTags
          ? mergeWithLocalBodyTags(remoteTags, updateFields.path ?? existing.path)
          : undefined

      if (indexTags) {
        setNoteTags(indexDb, itemId, indexTags)
      }

      if (propertiesPresent) {
        const getType = (name: string, value: unknown) => {
          const existing = getCanonicalPropertyDefinition(ctx.db, name)
          const type = resolvePropertyType(
            name,
            value,
            existing?.type as PropertyType | undefined,
            inferPropertyType
          )
          // `relation` has no PropertyDefinitionSchema member, so it is never
          // persisted — it is re-derived from the value on every pass instead.
          if (isPersistableDefinitionType(type)) {
            saveCanonicalPropertyDefinition(ctx.db, { name, type })
          }
          return type
        }
        setNoteProperties(indexDb, itemId, remoteProperties, getType)
      }

      if (data.pinnedTags) {
        applyPinnedTags(indexDb, itemId, data.pinnedTags)
      }

      // Union-only merge with no prune path is why a reference to a deleted
      // attachment lived in the note's payload forever. Peers on older builds
      // still send it, so the merge stays union — pruning is the deliberate,
      // evidence-based exit: only ids this device has itself watched the server
      // 404 are dropped.
      const mergedAttachmentRefs = mergeAttachmentReferences(
        existing.attachmentReferences,
        data.attachmentReferences
      )
      const prunedAttachmentRefs = mergedAttachmentRefs
        ? pruneUnresolvableReferences(ctx.db, itemId, mergedAttachmentRefs)
        : undefined

      updateNoteCache(indexDb, itemId, updateFields)
      updateNoteMetadata(ctx.db, itemId, {
        path: updateFields.path ?? existing.path,
        title: newTitle,
        emoji: resolvedEmoji,
        clock: resolution.mergedClock,
        syncedAt: now,
        modifiedAt: data.modifiedAt ?? now,
        ...(prunedAttachmentRefs ? { attachmentReferences: prunedAttachmentRefs } : {}),
        propertyDefinitionNames:
          remoteProperties && Object.keys(remoteProperties).length > 0
            ? Object.keys(remoteProperties).sort((a, b) => a.localeCompare(b))
            : undefined
      })

      requestEmbeddedAttachmentDownloads(ctx.db, itemId, data.attachmentReferences)

      // Frontmatter is the source of truth for a markdown note's project
      // membership, and this branch just rewrote it. The create path derives the
      // `project_links` rows from the `note.upserted` event `syncNoteToCache`
      // publishes; this one publishes nothing, so it has to reconcile directly.
      // Without this the note shows its project chip here while the project hub
      // stays empty — and the next rename of that project skips the note, which
      // unlinks it from the renamed project on every device.
      if (propertiesPresent && isMarkdownNote(ctx.db, itemId)) {
        try {
          reconcileNoteLinks(itemId, remoteProperties)
        } catch (err) {
          // Everything else about the note applied; a link reconcile failure
          // must not turn the whole pull into a retry.
          log.error('Failed to reconcile project links for synced note update', {
            itemId,
            error: err
          })
        }
      }

      // This branch rewrites frontmatter, title and path — never the note body.
      // Body edits arrive separately through the CRDT write-back. Leaving
      // `content` out is what keeps an open editor from remounting on a pull
      // that did not touch its text.
      emitNoteUpdated(ctx.emit, {
        id: itemId,
        changes: {
          title: newTitle,
          emoji: resolvedEmoji,
          ...(indexTags ? { tags: indexTags } : {})
        },
        source: 'sync'
      })
      if (tagsChanged) {
        ctx.emit('notes:tags-changed', {})
      }
      return resolution.action === 'merge' ? 'conflict' : 'applied'
    }

    const notesDir = getVaultRoot()
    const title = data.title ?? 'Untitled'

    if (data.fileType && isBinaryFileType(data.fileType)) {
      const ext =
        (data.mimeType ? getExtensionFromMimeType(data.mimeType) : null) ??
        getDefaultExtension(data.fileType as FileType)
      const basePath = generateFilePath(notesDir, title, ext, data.folderPath ?? undefined)
      const absolutePath = generateUniquePathSync(
        basePath,
        (p) => !!getNoteCacheByPath(indexDb, toRelativePath(p))
      )
      const relPath = toRelativePath(absolutePath)

      syncFileToCache(indexDb, {
        id: itemId,
        path: relPath,
        title,
        fileType: data.fileType as Exclude<FileType, 'markdown'>,
        mimeType: data.mimeType ?? getMimeType(ext) ?? null,
        fileSize: 0,
        createdAt: data.createdAt ? new Date(data.createdAt) : new Date(),
        modifiedAt: data.modifiedAt ? new Date(data.modifiedAt) : new Date()
      })
      void flushProjectionEvents()
      updateNoteCache(indexDb, itemId, {
        clock: remoteClock,
        syncedAt: now,
        emoji: data.emoji ?? null,
        attachmentId: data.attachmentId ?? null
      })
      updateNoteMetadata(ctx.db, itemId, {
        path: relPath,
        title,
        emoji: data.emoji ?? null,
        fileType: data.fileType as Exclude<FileType, 'markdown'>,
        mimeType: data.mimeType ?? getMimeType(ext) ?? null,
        fileSize: 0,
        attachmentId: data.attachmentId ?? null,
        clock: remoteClock,
        syncedAt: now,
        createdAt: data.createdAt ? new Date(data.createdAt).toISOString() : now,
        modifiedAt: data.modifiedAt ? new Date(data.modifiedAt).toISOString() : now
      })

      if (data.attachmentId) {
        attachmentEvents.emitDownloadNeeded({
          noteId: itemId,
          attachmentId: data.attachmentId,
          diskPath: absolutePath
        })
      }

      ctx.emit(NotesChannels.events.CREATED, {
        note: { id: itemId, path: relPath, title },
        source: 'sync'
      })
      return 'applied'
    }

    const content = data.content ?? ''

    // User keys only — Memry state (id, title, dates, emoji) stays in the DBs
    const frontmatter: NoteFrontmatter = {
      ...(data.tags?.length ? { tags: data.tags } : {}),
      ...(data.aliases?.length ? { aliases: data.aliases } : {}),
      ...(data.properties && Object.keys(data.properties).length > 0
        ? { properties: data.properties }
        : {})
    }

    const fileContent = serializeNote(frontmatter, content)
    const basePath = generateNotePath(notesDir, title, data.folderPath ?? undefined)
    const absolutePath = generateUniquePathSync(
      basePath,
      (p) => !!getNoteCacheByPath(indexDb, toRelativePath(p))
    )
    const relPath = toRelativePath(absolutePath)

    syncNoteToCache(
      indexDb,
      {
        id: itemId,
        path: relPath,
        fileContent,
        frontmatter,
        parsedContent: content,
        title,
        createdAt: data.createdAt ?? now,
        modifiedAt: data.modifiedAt ?? now,
        emoji: data.emoji ?? null
      },
      { isNew: true }
    )
    void flushProjectionEvents()
    updateNoteCache(indexDb, itemId, { clock: remoteClock, syncedAt: now })
    updateNoteMetadata(ctx.db, itemId, {
      clock: remoteClock,
      syncedAt: now,
      ...(data.attachmentReferences?.length
        ? { attachmentReferences: data.attachmentReferences }
        : {}),
      propertyDefinitionNames:
        data.properties && Object.keys(data.properties).length > 0
          ? Object.keys(data.properties).sort((a, b) => a.localeCompare(b))
          : undefined
    })

    if (data.pinnedTags) {
      applyPinnedTags(indexDb, itemId, data.pinnedTags)
    }

    markWritebackIgnored(absolutePath)
    const dir = path.dirname(absolutePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmpPath = absolutePath + '.tmp'
    fs.writeFileSync(tmpPath, fileContent, 'utf-8')
    fs.renameSync(tmpPath, absolutePath)

    requestEmbeddedAttachmentDownloads(ctx.db, itemId, data.attachmentReferences)

    ctx.emit(NotesChannels.events.CREATED, {
      note: { id: itemId, path: relPath, title },
      source: 'sync'
    })
    return 'applied'
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const indexDb = getIndexDatabase()
    const existing = getNoteMetadataById(ctx.db, itemId)
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote note delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    const absolutePath = toAbsolutePath(existing.path)
    deleteNoteFromCache(indexDb, itemId)
    void flushProjectionEvents()

    // A remote delete must drop the note's project links + clear any project home
    // note pointing at it, exactly like the local path (notes/domain
    // deleteNoteCommand) — otherwise the receiving device keeps orphan
    // project_links rows and a dangling projects.home_note_id.
    void cleanupProjectLinksForDeletedNote(itemId).catch((err) => {
      log.error('Failed to clean up project links for synced note delete', { itemId, error: err })
    })
    ctx.emit(NotesChannels.events.DELETED, { id: itemId, path: existing.path, source: 'sync' })

    markWritebackIgnored(absolutePath)
    deleteFile(absolutePath).catch((err) => {
      log.error('Failed to delete synced note file', { itemId, error: err })
    })
    return 'applied'
  }

  fetchLocal(_db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return fetchLocalNote(itemId)
  }

  /**
   * Stamp the note as "the server has this state". Without it `syncedAt` only
   * ever recorded incoming pulls, so dirty-recovery could not tell a note whose
   * push was lost from one that is perfectly in step.
   */
  markPushSynced(db: DrizzleDb, itemId: string): void {
    updateNoteMetadata(db, itemId, { syncedAt: utcNow() })
  }

  buildPushPayload(
    _db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    operation: string
  ): string | null {
    return buildNotePushPayload(itemId, operation)
  }

  seedUnclocked(_db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    return seedUnclockedNotes(deviceId, queue)
  }
}

export const noteHandler = new NoteHandler()
