import type { FileType } from '@memry/shared/file-types'
import type { VectorClock } from '@memry/contracts/sync-api'
import {
  NoteSyncPolicies,
  type NewNoteMetadata,
  type NoteMetadata,
  type NoteSyncPolicy
} from '@memry/db-schema/data-schema'
import {
  deleteNoteMetadata,
  upsertNoteMetadata,
  updateNoteMetadata,
  upsertPropertyDefinition,
  type NoteMetadataDb
} from '@memry/storage-data/note-metadata-repository'

export interface UpsertCanonicalNoteInput {
  id: string
  path: string
  title: string
  emoji?: string | null
  fileType?: FileType
  mimeType?: string | null
  fileSize?: number | null
  attachmentId?: string | null
  attachmentReferences?: string[] | null
  localOnly?: boolean
  syncPolicy?: NoteSyncPolicy
  journalDate?: string | null
  propertyDefinitionNames?: string[] | null
  properties?: Record<string, unknown> | null
  clock?: VectorClock
  syncedAt?: string | null
  createdAt: string
  modifiedAt: string
}

export interface UpsertCanonicalPropertyDefinitionInput {
  name: string
  type: string
  options?: string | null
  defaultValue?: string | null
  color?: string | null
}

export function resolveNoteSyncPolicy(
  localOnly: boolean | undefined,
  syncPolicy?: NoteSyncPolicy
): NoteSyncPolicy {
  if (syncPolicy) {
    return syncPolicy
  }
  return localOnly ? NoteSyncPolicies.LOCAL_ONLY : NoteSyncPolicies.SYNC
}

export function buildCanonicalNoteMetadata(input: UpsertCanonicalNoteInput): NewNoteMetadata {
  const propertyDefinitionNames =
    input.propertyDefinitionNames ??
    (input.properties ? Object.keys(input.properties).sort((a, b) => a.localeCompare(b)) : null)
  const attachmentReferences =
    input.attachmentReferences ?? (input.attachmentId ? [input.attachmentId] : null)
  const localOnly = input.localOnly ?? false

  return {
    id: input.id,
    path: input.path,
    title: input.title,
    emoji: input.emoji ?? null,
    fileType: input.fileType ?? 'markdown',
    mimeType: input.mimeType ?? null,
    fileSize: input.fileSize ?? null,
    attachmentId: input.attachmentId ?? null,
    attachmentReferences,
    localOnly,
    syncPolicy: resolveNoteSyncPolicy(localOnly, input.syncPolicy),
    journalDate: input.journalDate ?? null,
    propertyDefinitionNames,
    clock: input.clock,
    syncedAt: input.syncedAt ?? null,
    createdAt: input.createdAt,
    modifiedAt: input.modifiedAt
  }
}

export function saveCanonicalNote(db: NoteMetadataDb, input: UpsertCanonicalNoteInput): NoteMetadata {
  return upsertNoteMetadata(db, buildCanonicalNoteMetadata(input))
}

export function deleteCanonicalNote(db: NoteMetadataDb, noteId: string): void {
  deleteNoteMetadata(db, noteId)
}

export function setCanonicalLocalOnly(
  db: NoteMetadataDb,
  noteId: string,
  localOnly: boolean
): NoteMetadata | undefined {
  return updateNoteMetadata(db, noteId, {
    localOnly,
    syncPolicy: resolveNoteSyncPolicy(localOnly)
  })
}

export function saveCanonicalPropertyDefinition(
  db: NoteMetadataDb,
  definition: UpsertCanonicalPropertyDefinitionInput
) {
  return upsertPropertyDefinition(db, {
    name: definition.name,
    type: definition.type,
    options: definition.options ?? null,
    defaultValue: definition.defaultValue ?? null,
    color: definition.color ?? null
  })
}
