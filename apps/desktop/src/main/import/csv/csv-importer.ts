/**
 * CSV importer (framework-native).
 *
 * Reads generic CSV files, maps each row to a note under CSV/, and saves
 * extra columns as note properties. Plugs into the unified import framework
 * (registry + preview + streaming progress).
 *
 * @module main/import/csv/csv-importer
 */

import { readFile } from 'fs/promises'
import { basename } from 'path'
import { parseCsv, mapRows } from '@memry/importers/csv'
import { IMPORT_MESSAGE_CODES, toImportMessage } from '@memry/importers/messages'
import { createNote } from '../../vault/notes-crud'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportPreview, ImportSummary } from '../types'

const logger = createLogger('CsvImport')

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'Import error'
}

/** Parse one file into a preview group. */
async function previewFile(filePath: string): Promise<ImportPreview['groups'][number]> {
  const text = await readFile(filePath, 'utf-8')
  const parsed = parseCsv(text)
  const plan = mapRows(parsed)
  return {
    label: basename(filePath),
    counts: [
      { labelKey: 'import.stats.notes', value: plan.stats.notes },
      { labelKey: 'import.stats.skipped', value: plan.stats.skipped }
    ],
    sampleTitles: plan.sampleTitles,
    warnings: [
      ...plan.warnings,
      {
        code: IMPORT_MESSAGE_CODES.csvColumns,
        message: `Columns: ${plan.columns.join(', ')}`,
        params: { columns: plan.columns.join(', ') }
      },
      {
        code: IMPORT_MESSAGE_CODES.csvTitleColumn,
        message: `Title from "${plan.titleColumn}"; other columns saved as properties`,
        params: { column: plan.titleColumn }
      }
    ]
  }
}

/** Preview each CSV file — no writes. */
async function preview(input: ImportInput, signal: AbortSignal): Promise<ImportPreview> {
  const groups: ImportPreview['groups'] = []
  for (const fp of input.sourcePaths) {
    if (signal.aborted) break
    try {
      groups.push(await previewFile(fp))
    } catch (err) {
      groups.push({
        label: basename(fp),
        counts: [],
        error: toImportMessage(err, {
          code: IMPORT_MESSAGE_CODES.readFileFailed,
          message: 'Failed to read file'
        })
      })
    }
  }
  return { groups }
}

/** Import each CSV file, creating notes under CSV/. */
async function run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
  ctx.setPhase('importing')
  ctx.status('Importing CSV notes…')

  // Parse all files upfront so we know the total row count.
  const plans: { fileName: string; plan?: ReturnType<typeof mapRows>; error?: string }[] = []
  for (const fp of input.sourcePaths) {
    try {
      const text = await readFile(fp, 'utf-8')
      plans.push({ fileName: basename(fp), plan: mapRows(parseCsv(text)) })
    } catch (err) {
      plans.push({ fileName: basename(fp), error: errorMessage(err) })
    }
  }

  const total = plans.reduce((n, p) => n + (p.plan?.notes.length ?? 0), 0)
  let done = 0
  ctx.reportProgress(0, total)

  for (const entry of plans) {
    if (ctx.isCancelled()) return ctx.toSummary()

    if (!entry.plan) {
      logger.error('CSV import failed for file', entry.fileName, entry.error)
      ctx.reportFailed(entry.fileName, entry.error)
      continue
    }

    for (const note of entry.plan.notes) {
      if (ctx.isCancelled()) return ctx.toSummary()

      try {
        ctx.status(`Importing ${note.title}`)
        await createNote({
          title: note.title,
          content: note.content,
          folder: note.folder,
          properties: note.properties
        })
        ctx.reportImported()
      } catch (err) {
        logger.warn('CSV note import failed', { title: note.title, file: entry.fileName })
        ctx.reportFailed(note.title, err)
      }

      done++
      ctx.reportProgress(done, total)
    }

    // Count skipped rows from this file.
    for (let i = 0; i < entry.plan.stats.skipped; i++) {
      ctx.reportSkipped(entry.fileName, 'empty title')
    }
  }

  return ctx.toSummary()
}

export const csvImporter: Importer = {
  id: 'csv',
  name: 'CSV',
  descriptionKey: 'import.sources.csv',
  fileSpec: { label: 'CSV files', extensions: ['csv'], allowMultiple: true },
  preview,
  run
}
