/**
 * Roam Research importer (orchestrator).
 *
 * Input is one or more Roam graph exports in `.json` form (each file is a
 * `RoamPage[]`). The pure `@memry/importers/roam` package does all transforms:
 *   1. index every block uid → its page (for `((uid))` resolution),
 *   2. convert each page's outline into a nested markdown bullet list + scrub
 *      Roam markup,
 *   3. resolve block references against the uid index (safe wikilink fallback).
 *
 * This orchestrator only does IO: read the JSON files, then `createNote` per
 * page under the `Roam/` root, honoring cancellation and reporting progress.
 *
 * Firebase asset download (`firebasestorage.googleapis.com` image URLs in block
 * text) is intentionally NOT implemented in v1 — such URLs are left inline as
 * plain links. See the docs section.
 */

import fs from 'fs/promises'
import { createNote } from '../../vault/notes-crud'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { indexBlocks, mapPages } from '@memry/importers/roam'
import type { BlockIndex, NotePlan, RoamPage } from '@memry/importers/roam'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'

const logger = createLogger('RoamImport')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

function isRoamPageArray(value: unknown): value is RoamPage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (page) =>
        typeof page === 'object' &&
        page !== null &&
        typeof (page as { title?: unknown }).title === 'string'
    )
  )
}

export const roamImporter: Importer = {
  id: 'roam',
  name: 'Roam',
  descriptionKey: 'import.sources.roam',
  fileSpec: { label: 'Roam JSON export', extensions: ['json'], allowMultiple: true },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    // ---- Pass 1: read + parse each JSON file, collect pages ----
    ctx.setPhase('scanning')
    ctx.status(IMPORT_STATUS.roamReading)

    const pages: RoamPage[] = []
    for (const sourcePath of input.sourcePaths) {
      if (ctx.isCancelled()) return ctx.toSummary()
      try {
        const raw = await fs.readFile(sourcePath, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (!isRoamPageArray(parsed)) {
          ctx.reportFailed(sourcePath, 'Not a Roam JSON export (expected an array of pages)')
          continue
        }
        pages.push(...parsed)
        ctx.reportProgress(pages.length, 0)
      } catch (error) {
        logger.warn('roam file read/parse failed', { sourcePath })
        ctx.reportFailed(sourcePath, error)
      }
    }

    if (ctx.isCancelled()) return ctx.toSummary()

    // ---- Phases 1–3 (pure): index uids, convert, resolve refs ----
    const index: BlockIndex = indexBlocks(pages)
    const plan = mapPages(pages, index)

    // ---- Pass 2: write one note per page ----
    ctx.setPhase('importing')
    const total = plan.notes.length
    let done = 0

    for (const note of plan.notes) {
      if (ctx.isCancelled()) return ctx.toSummary()
      await writeNote(note, ctx)
      done++
      ctx.reportProgress(done, total)
    }

    return ctx.toSummary()
  }
}

async function writeNote(note: NotePlan, ctx: ImportContext): Promise<void> {
  try {
    ctx.status(importingItemStatus(note.title))
    await createNote({
      title: note.title,
      content: note.body,
      folder: note.folder,
      created: note.created ?? undefined,
      modified: note.modified ?? undefined
    })
    ctx.reportImported()
  } catch (error) {
    logger.warn('roam page import failed', { title: note.title, error: errorMessage(error) })
    ctx.reportFailed(note.title, error)
  }
}
