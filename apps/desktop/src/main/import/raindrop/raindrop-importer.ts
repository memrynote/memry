/**
 * Raindrop CSV importer (framework-native).
 *
 * Reuses the pure `@memry/importers/raindrop` package to parse a Raindrop.io
 * bookmark CSV export into inbox-item plans, then lands each bookmark in the
 * inbox as a `link` item. Plugs into the generic import framework (registry +
 * preview + streaming progress).
 *
 * @module main/import/raindrop/raindrop-importer
 */

import { readFile } from 'fs/promises'
import { basename } from 'path'
import {
  parseRaindropCsv,
  mapRows,
  type InboxItemPlan,
  type RaindropImportPlan
} from '@memry/importers/raindrop'
import { IMPORT_MESSAGE_CODES, IMPORT_STATUS, toImportMessage } from '@memry/importers/messages'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportPreview } from '../types'

const logger = createLogger('RaindropImport')

/** The one write the importer performs, abstracted so it stays unit-testable. */
export interface ApplyDeps {
  saveBookmark(item: InboxItemPlan): void
}

/** Build the real (db-backed) apply deps lazily so importing this module stays light. */
async function defaultDeps(): Promise<ApplyDeps> {
  const { requireDatabase } = await import('../../database')
  const { insertItemWithTags, emitCapturedAndSync } = await import('../../inbox/domain')
  const { queueInboxArticleExtractJob } = await import('../../inbox/jobs')
  const { generateId } = await import('../../lib/id')

  const db = requireDatabase()
  return {
    saveBookmark: (item) => {
      const now = new Date().toISOString()
      const { row, tags } = insertItemWithTags(
        db,
        {
          id: generateId(),
          type: 'link',
          title: item.title,
          content: item.content,
          sourceUrl: item.sourceUrl,
          createdAt: item.createdAt,
          modifiedAt: now,
          processingStatus: 'complete',
          captureSource: 'api',
          metadata: item.metadata
        },
        item.tags
      )
      // ponytail: emits a captured event + sync write per row; fine at export scale.
      // Batch the projection/sync refresh only if a very large export visibly stutters.
      emitCapturedAndSync(row, tags)

      // Pull in the page's readable article content in the background, using the
      // same durable defuddle job the paste-a-link flow uses. It enriches `content`
      // (CSV note + excerpt stay the fallback if extraction fails) and leaves the
      // Raindrop-curated title + tags untouched. http(s) only.
      // ponytail: queue is single-threaded ~10-15s/URL; huge exports enrich over
      // time in the background — acceptable, mirrors pasting N links.
      if (/^https?:\/\//i.test(item.sourceUrl)) {
        queueInboxArticleExtractJob(row.id, item.sourceUrl)
      }
    }
  }
}

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : fallback

async function planForFile(filePath: string, now: string): Promise<RaindropImportPlan> {
  const raw = await readFile(filePath, 'utf-8')
  return mapRows(parseRaindropCsv(raw), { now })
}

/** Parse each file into preview groups — performs no writes. */
export async function buildRaindropPreview(
  filePaths: string[],
  now: string,
  signal?: AbortSignal
): Promise<ImportPreview> {
  const groups: ImportPreview['groups'] = []
  for (const fp of filePaths) {
    if (signal?.aborted) break
    try {
      const plan = await planForFile(fp, now)
      groups.push({
        label: basename(fp),
        counts: [
          { labelKey: 'import.stats.bookmarks', value: plan.stats.bookmarks },
          { labelKey: 'import.stats.withTags', value: plan.stats.withTags },
          { labelKey: 'import.stats.skipped', value: plan.stats.skipped }
        ],
        sampleTitles: plan.sampleTitles,
        warnings: plan.warnings
      })
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

/**
 * Parse + apply each file's plan, streaming progress through `ctx`. A failing
 * file is isolated; per-row failures are reported but never abort the run.
 */
export async function runRaindropImport(
  filePaths: string[],
  deps: ApplyDeps,
  ctx: ImportContext,
  now: string
): Promise<void> {
  const parsed: { fileName: string; plan?: RaindropImportPlan; error?: string }[] = []
  for (const fp of filePaths) {
    try {
      parsed.push({ fileName: basename(fp), plan: await planForFile(fp, now) })
    } catch (err) {
      parsed.push({ fileName: basename(fp), error: errorMessage(err, 'Import failed') })
    }
  }

  const total = parsed.reduce((n, p) => n + (p.plan?.items.length ?? 0), 0)
  let done = 0
  ctx.reportProgress(0, total)

  for (const entry of parsed) {
    if (ctx.isCancelled()) return
    if (!entry.plan) {
      logger.error('Raindrop import failed for file', entry.fileName, entry.error)
      ctx.reportFailed(entry.fileName, entry.error)
      continue
    }
    for (const warning of entry.plan.warnings) {
      ctx.reportSkipped(warning.message)
    }
    for (const item of entry.plan.items) {
      if (ctx.isCancelled()) return
      try {
        deps.saveBookmark(item)
        ctx.reportImported()
      } catch (err) {
        logger.error('Raindrop import failed for bookmark', item.sourceUrl, err)
        ctx.reportFailed(item.title || item.sourceUrl, err)
      }
      done++
      ctx.reportProgress(done, total)
    }
  }
}

export const raindropImporter: Importer = {
  id: 'raindrop',
  name: 'Raindrop',
  descriptionKey: 'import.sources.raindrop',
  fileSpec: { label: 'Raindrop CSV export', extensions: ['csv'], allowMultiple: true },
  preview: (input, signal) =>
    buildRaindropPreview(input.sourcePaths, new Date().toISOString(), signal),
  run: async (input, ctx) => {
    ctx.setPhase('importing')
    ctx.status(IMPORT_STATUS.raindropImporting)
    const deps = await defaultDeps()
    await runRaindropImport(input.sourcePaths, deps, ctx, new Date().toISOString())
    return ctx.toSummary()
  }
}
