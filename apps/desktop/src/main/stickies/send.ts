/**
 * Send sticky text where it belongs: a note in the vault's Sticky folder, a
 * task, or a paragraph at the end of today's journal entry. A note or task
 * send can be undone for a while; the draft comes back with the same text.
 *
 * @module main/stickies/send
 */

import type {
  StickyKind,
  StickySendInput,
  StickySendResult,
  StickyUndoResult
} from '@memry/contracts/sticky-api'
import { formatDateKey } from '@memry/domain-tasks/parsing'
import { getDatabase } from '../database'
import { getInboxProject, listProjects } from '../database/queries/projects'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import { getMainI18n } from '../lib/main-i18n'
import { createNoteCommand, deleteNoteCommand } from '../notes/domain'
import { createFolder, getFolders } from '../vault/notes'
import { syncFolderConfigCreate } from '../notes/folder-config-effects'
import { createDesktopTasksDomain } from '../tasks/domain'
import { createTasksPublisher } from '../tasks/publisher'
import { appendToJournalEntry } from '../journal/update-entry'
import { getFeaturesSettings } from '../settings/features'
import { getTaskSettings } from '../settings/task-settings'
import { rememberStickyKind } from '../settings/sticky-settings'
import { deleteStickyDraft, saveStickyDraft } from './drafts'
import { toStickyTaskInput } from './task-input'
import { splitStickyText } from './text'

const log = createLogger('StickySend')

/**
 * Vault-relative folder for sticky notes. Not localized: two devices in
 * different languages share one vault and must land in the same folder.
 */
export const STICKY_FOLDER = 'Sticky'

/**
 * How long Undo stays possible after a send. The sticky offers it only while
 * its confirmation shows; past that the created item may hold edits that an
 * undo would delete.
 */
const UNDO_WINDOW_MS = 60 * 1000

interface UndoEntry {
  kind: 'note' | 'task'
  targetId: string
  content: string
  expiresAt: number
}

const undoEntries = new Map<string, UndoEntry>()

function t(key: string): string {
  return getMainI18n().getFixedT(null, 'inbox')(key)
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

function tasksDomain(): ReturnType<typeof createDesktopTasksDomain> {
  return createDesktopTasksDomain(getDatabase(), createTasksPublisher(), generateId)
}

async function ensureStickyFolder(): Promise<void> {
  const folders = await getFolders()
  if (folders.some((folder) => folder.path === STICKY_FOLDER)) return
  await createFolder(STICKY_FOLDER)
  syncFolderConfigCreate(STICKY_FOLDER)
}

async function sendToNote(content: string): Promise<{ targetId: string; title: string }> {
  const { firstLine, rest } = splitStickyText(content)
  await ensureStickyFolder()
  const note = await createNoteCommand({ title: firstLine, content: rest, folder: STICKY_FOLDER })
  return { targetId: note.id, title: note.title }
}

async function sendToTask(content: string): Promise<{ targetId: string; title: string }> {
  const db = getDatabase()
  const projects = listProjects(db)
  const configuredDefault = getTaskSettings().defaultProjectId
  const input = toStickyTaskInput(content, {
    projects: projects.map((p) => ({ id: p.id, name: p.name, isArchived: p.archivedAt !== null })),
    defaultProjectId: projects.some((p) => p.id === configuredDefault) ? configuredDefault : null,
    inboxProjectId: getInboxProject(db)?.id ?? 'inbox',
    now: new Date()
  })

  const result = await tasksDomain().createTask(input)
  if (!result.success || !result.task) {
    throw new Error(result.error ?? t('sticky.errors.taskFailed'))
  }
  return { targetId: result.task.id, title: result.task.title }
}

async function sendToJournal(content: string): Promise<{ targetId: string; title: string }> {
  const date = formatDateKey(new Date())
  await appendToJournalEntry(date, content)
  return { targetId: date, title: date }
}

function assertKindEnabled(kind: StickyKind): void {
  const features = getFeaturesSettings()
  if (kind === 'task' && !features.tasks) throw new Error(t('sticky.errors.tasksOff'))
  if (kind === 'journal' && !features.journal) throw new Error(t('sticky.errors.journalOff'))
}

function pruneUndoEntries(now: number): void {
  for (const [token, entry] of undoEntries) {
    if (entry.expiresAt <= now) undoEntries.delete(token)
  }
}

export async function sendSticky(input: StickySendInput): Promise<StickySendResult> {
  const content = input.content.trim()
  if (!content) return { success: false, error: t('sticky.errors.empty') }

  try {
    assertKindEnabled(input.kind)
    const sent =
      input.kind === 'note'
        ? await sendToNote(content)
        : input.kind === 'task'
          ? await sendToTask(content)
          : await sendToJournal(content)

    // The text now lives in its target; only then does the draft go.
    if (input.draftId) deleteStickyDraft(input.draftId)
    rememberStickyKind(input.kind)

    let undoToken: string | null = null
    if (input.kind !== 'journal') {
      const now = Date.now()
      pruneUndoEntries(now)
      undoToken = generateId()
      undoEntries.set(undoToken, {
        kind: input.kind,
        targetId: sent.targetId,
        content,
        expiresAt: now + UNDO_WINDOW_MS
      })
    }

    return { success: true, kind: input.kind, ...sent, undoToken }
  } catch (err) {
    log.error('Sticky send failed', { kind: input.kind, error: err })
    return { success: false, error: errorMessage(err, t('sticky.errors.sendFailed')) }
  }
}

export async function undoStickySend(undoToken: string): Promise<StickyUndoResult> {
  pruneUndoEntries(Date.now())
  const entry = undoEntries.get(undoToken)
  if (!entry) return { success: false, error: t('sticky.errors.undoExpired') }
  undoEntries.delete(undoToken)

  try {
    if (entry.kind === 'note') {
      await deleteNoteCommand(entry.targetId)
    } else {
      await tasksDomain().deleteTask(entry.targetId)
    }
    return { success: true, draft: saveStickyDraft({ content: entry.content, kind: entry.kind }) }
  } catch (err) {
    log.error('Sticky undo failed', { kind: entry.kind, error: err })
    return { success: false, error: errorMessage(err, t('sticky.errors.undoFailed')) }
  }
}
