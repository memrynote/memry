import {
  READWISE_CATEGORIES,
  READWISE_PREVIEW_COUNT_KEYS,
  type ImportMessage,
  type ImportPreviewGroup
} from '@memry/contracts/import-channels'
import { IMPORT_MESSAGE_CODES, IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'
import { createLogger } from '../../lib/logger'
import { getMainI18n } from '../../lib/main-i18n'
import { ReadwiseError } from '../../readwise/client'
import { describeReadwiseError } from '../../readwise/connection'
import { getReadwiseToken } from '../../readwise/secrets'
import {
  countLibrary,
  getReadwiseSyncService,
  type BookEvent,
  type PreviewCategory
} from '../../readwise/sync-service'
import { getStatus } from '../../vault'
import type { ImportContext, ImportInput, ImportPreview, ImportSummary, Importer } from '../types'

const log = createLogger('ReadwiseImport')

function requireVaultPath(): string {
  const { path: vaultPath } = getStatus()
  if (!vaultPath) throw new Error(getMainI18n().t('errors:ipc.noVaultOpen'))
  return vaultPath
}

async function requireToken(): Promise<string> {
  const token = await getReadwiseToken(requireVaultPath())
  if (token === null) throw new Error(getMainI18n().t('errors:importer.readwiseNotConnected'))
  return token
}

const SKIP_REASONS: Record<
  Extract<BookEvent, { result: 'skipped' }>['reason'] | 'unchanged',
  ImportMessage
> = {
  unchanged: {
    code: IMPORT_MESSAGE_CODES.readwiseUnchanged,
    message: 'Already up to date'
  },
  'category-off': {
    code: IMPORT_MESSAGE_CODES.readwiseCategoryOff,
    message: 'In a category you turned off'
  },
  'source-deleted': {
    code: IMPORT_MESSAGE_CODES.readwiseSourceDeleted,
    message: 'Deleted in Readwise; the note stays'
  },
  'note-deleted': {
    code: IMPORT_MESSAGE_CODES.readwiseNoteDeleted,
    message: 'You deleted the note; it stays deleted'
  },
  busy: {
    code: IMPORT_MESSAGE_CODES.readwiseBusy,
    message: 'Open in an editor; written on the next run'
  }
}

function previewError(code: ImportMessage['code'], message: string): ImportPreview {
  return { groups: [{ label: 'Readwise', counts: [], error: { code, message } }] }
}

/**
 * Readwise is an account-based importer (#1408 D1). `preview` and `run` are
 * the two halves of the sync engine's first run: composition only, with no
 * HTTP and no markdown here (`readwise/sync-service.ts` owns the run).
 */
export const readwiseImporter: Importer = {
  id: 'readwise',
  name: 'Readwise',
  descriptionKey: 'import.sources.readwise',
  accountBased: true,
  fileSpec: {
    label: 'Readwise',
    extensions: [],
    allowMultiple: false
  },

  /** Counts per category, without writing. Group labels are category ids, and `other` shows only when present. */
  async preview(_input: ImportInput, signal: AbortSignal): Promise<ImportPreview> {
    const token = await getReadwiseToken(requireVaultPath())
    if (token === null) {
      return previewError(IMPORT_MESSAGE_CODES.readwiseTokenMissing, 'Readwise is not connected')
    }
    try {
      const counts = await countLibrary(token, signal)
      const categories: PreviewCategory[] = [...READWISE_CATEGORIES, 'other']
      const groups: ImportPreviewGroup[] = categories
        .filter((category) => category !== 'other' || counts.other.books > 0)
        .map((category) => ({
          label: category,
          counts: [
            { labelKey: READWISE_PREVIEW_COUNT_KEYS.books, value: counts[category].books },
            { labelKey: READWISE_PREVIEW_COUNT_KEYS.highlights, value: counts[category].highlights }
          ],
          sampleTitles: counts[category].sampleTitles
        }))
      return { groups }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ReadwiseError) {
        log.warn('Readwise preview failed', { code: error.code })
        return error.code === 'invalid-token'
          ? previewError(IMPORT_MESSAGE_CODES.readwiseTokenInvalid, 'Readwise rejected the token')
          : previewError(IMPORT_MESSAGE_CODES.readwiseUnreachable, 'Could not reach Readwise')
      }
      throw error
    }
  },

  async run(_input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    const token = await requireToken()
    let total = 0
    let completed = 0
    try {
      ctx.setPhase('scanning')
      await getReadwiseSyncService().run(token, {
        signal: ctx.signal,
        // The runner writes the activity line for an import run.
        logActivity: false,
        reading: () => ctx.status(IMPORT_STATUS.readwiseFetching),
        planned: (count) => {
          total = count
          ctx.setPhase('importing')
          ctx.reportProgress(0, total)
        },
        writing: (title) => ctx.status(importingItemStatus(title)),
        book: (event) => {
          if (event.result === 'failed') ctx.reportFailed(event.title, event.reason)
          else if (event.result === 'skipped')
            ctx.reportSkipped(event.title, SKIP_REASONS[event.reason])
          else if (event.result === 'unchanged')
            ctx.reportSkipped(event.title, SKIP_REASONS.unchanged)
          else ctx.reportImported()
          ctx.reportProgress(++completed, total)
        }
      })
    } catch (error) {
      const message = describeReadwiseError(error)
      if (message === null) throw error
      throw new Error(message, { cause: error })
    }
    return ctx.toSummary()
  }
}
