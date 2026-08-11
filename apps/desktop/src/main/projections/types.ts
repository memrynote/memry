import type { FileType } from '@memry/shared/file-types'

export interface MarkdownNoteProjection {
  kind: 'markdown'
  noteId: string
  path: string
  title: string
  fileType: 'markdown'
  localOnly: boolean
  contentHash: string
  wordCount: number
  characterCount: number
  snippet: string
  date: string | null
  emoji: string | null
  createdAt: string
  modifiedAt: string
  parsedContent: string
  tags: string[]
  properties: Record<string, unknown>
  wikiLinks: string[]
}

export interface FileNoteProjection {
  kind: 'file'
  noteId: string
  path: string
  title: string
  fileType: Exclude<FileType, 'markdown'>
  mimeType: string | null
  fileSize: number
  createdAt: string
  modifiedAt: string
}

export type NoteProjectionRecord = MarkdownNoteProjection | FileNoteProjection

export type ProjectionEvent =
  | {
      type: 'note.upserted'
      note: NoteProjectionRecord
    }
  | {
      type: 'note.deleted'
      noteId: string
      path?: string
    }
  | {
      type: 'task.upserted'
      taskId: string
    }
  | {
      type: 'task.deleted'
      taskId: string
    }
  | {
      type: 'inbox.upserted'
      itemId: string
    }
  | {
      type: 'inbox.deleted'
      itemId: string
    }
  | {
      type: 'inbox.filed'
      itemId: string
    }
  | {
      type: 'inbox.unfiled'
      itemId: string
    }
  | {
      type: 'inbox.archived'
      itemId: string
    }
  | {
      type: 'inbox.unarchived'
      itemId: string
    }

export interface ProjectionProjector {
  name: string
  handles(event: ProjectionEvent): boolean
  project(event: ProjectionEvent): void | Promise<void>
  rebuild(): unknown
  /**
   * Consistency pass. Runs backgrounded on every vault open, so it must stop
   * promptly when `signal` aborts — otherwise a vault switch leaves the old
   * pass reading the previous vault against a closed database (#993).
   */
  reconcile(signal?: AbortSignal): unknown
}

export interface ProjectionLogger {
  debug?: (message: string, meta?: unknown) => void
  info?: (message: string, meta?: unknown) => void
  warn?: (message: string, meta?: unknown) => void
  error?: (message: string, meta?: unknown) => void
}
