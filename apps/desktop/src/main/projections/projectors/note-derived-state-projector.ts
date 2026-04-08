import fs from 'fs'
import path from 'path'
import { createLogger } from '../../lib/logger'
import {
  deleteLinksToNote,
  deleteNoteCache,
  extractDateFromPath,
  getNoteCacheById,
  getPropertyType,
  insertNoteCache,
  listNotesFromCache,
  resolveNotesByTitles,
  setNoteLinks,
  setNoteProperties,
  setNoteTags,
  updateNoteCache
} from '@main/database/queries/notes'
import { getIndexDatabase } from '../../database'
import { inferPropertyType } from '../../vault/frontmatter'
import type { NoteProjectionRecord, ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:NoteState')

function persistMarkdownNote(note: Extract<NoteProjectionRecord, { kind: 'markdown' }>): void {
  const db = getIndexDatabase()
  const existing = getNoteCacheById(db, note.noteId)

  if (existing) {
    updateNoteCache(db, note.noteId, {
      path: note.path,
      title: note.title,
      emoji: note.emoji,
      localOnly: note.localOnly,
      contentHash: note.contentHash,
      wordCount: note.wordCount,
      characterCount: note.characterCount,
      snippet: note.snippet,
      modifiedAt: note.modifiedAt
    })
  } else {
    insertNoteCache(db, {
      id: note.noteId,
      path: note.path,
      title: note.title,
      emoji: note.emoji,
      localOnly: note.localOnly,
      fileType: 'markdown',
      contentHash: note.contentHash,
      wordCount: note.wordCount,
      characterCount: note.characterCount,
      snippet: note.snippet,
      date: note.date ?? extractDateFromPath(note.path),
      createdAt: note.createdAt,
      modifiedAt: note.modifiedAt
    })
  }

  setNoteTags(db, note.noteId, note.tags)
  setNoteProperties(db, note.noteId, note.properties, (name, value) =>
    getPropertyType(db, name, value, inferPropertyType)
  )

  const resolvedTitles = resolveNotesByTitles(db, note.wikiLinks)
  const links = note.wikiLinks.map((title) => {
    const resolved = resolvedTitles.get(title)
    return { targetTitle: title, targetId: resolved?.id }
  })
  setNoteLinks(db, note.noteId, links)
}

function persistFileNote(note: Extract<NoteProjectionRecord, { kind: 'file' }>): void {
  const db = getIndexDatabase()
  const existing = getNoteCacheById(db, note.noteId)

  if (existing) {
    updateNoteCache(db, note.noteId, {
      path: note.path,
      title: note.title,
      fileType: note.fileType,
      mimeType: note.mimeType,
      fileSize: note.fileSize,
      modifiedAt: note.modifiedAt
    })
    return
  }

  insertNoteCache(db, {
    id: note.noteId,
    path: note.path,
    title: note.title,
    fileType: note.fileType,
    mimeType: note.mimeType,
    fileSize: note.fileSize,
    contentHash: null,
    wordCount: null,
    characterCount: null,
    snippet: null,
    emoji: null,
    date: null,
    createdAt: note.createdAt,
    modifiedAt: note.modifiedAt
  })
}

function deleteNote(noteId: string): void {
  const db = getIndexDatabase()
  deleteLinksToNote(db, noteId)
  deleteNoteCache(db, noteId)
}

function reconcileMissingFiles(): void {
  const db = getIndexDatabase()
  const cachedNotes = listNotesFromCache(db, { limit: 100000 })
  const vaultPath = currentVaultPathProvider?.()

  if (!vaultPath) {
    return
  }

  for (const cached of cachedNotes) {
    const absolutePath = path.join(vaultPath, cached.path)
    if (!fs.existsSync(absolutePath)) {
      deleteNote(cached.id)
    }
  }
}

let currentVaultPathProvider: (() => string | null) | null = null

export function createNoteDerivedStateProjector(
  getVaultPath: () => string | null
): ProjectionProjector {
  currentVaultPathProvider = getVaultPath

  return {
    name: 'note-derived-state',
    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted' || event.type === 'note.deleted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type === 'note.deleted') {
        deleteNote(event.noteId)
        return
      }

      if (event.type !== 'note.upserted') {
        return
      }

      const note = event.note

      if (note.kind === 'markdown') {
        persistMarkdownNote(note)
        return
      }

      persistFileNote(note)
    },

    async rebuild(): Promise<void> {
      reconcileMissingFiles()
    },

    async reconcile(): Promise<void> {
      reconcileMissingFiles()
      logger.debug?.('Reconciled note-derived state')
    }
  }
}
