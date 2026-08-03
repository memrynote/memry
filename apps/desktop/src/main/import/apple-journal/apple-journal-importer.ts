import { readFile } from 'fs/promises'
import * as path from 'path'
import { JSDOM } from 'jsdom'
import { createNote } from '../../vault/notes-crud'
import { createLogger } from '../../lib/logger'
import { htmlToMarkdown } from '../_shared/html-to-markdown'
import { parseJournalDate, mapEntry } from '@memry/importers/apple-journal'
import { importingItemStatus } from '@memry/importers/messages'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'

const logger = createLogger('AppleJournalImport')

const IGNORED_ASSET_TYPES = new Set(['photo', 'live-photo', 'video'])

function collectTokens(doc: Document): string[] {
  const tokens: string[] = []
  for (const gridItem of Array.from(doc.querySelectorAll('.assetGrid .gridItem'))) {
    const typeEl = gridItem.querySelector('.activityType')
    const rawType = typeEl?.textContent?.trim() ?? ''
    // Skip media assets entirely — we don't import them
    if (IGNORED_ASSET_TYPES.has(rawType)) continue

    // Collect all overlay text tokens from non-ignored items
    for (const overlay of Array.from(
      gridItem.querySelectorAll(
        '.gridItemOverlayHeader, .gridItemOverlayFooter, .gridItemOverlayText, .activityType, .mediaTitle'
      )
    )) {
      const text = overlay.textContent?.trim()
      if (text) tokens.push(text)
    }
  }
  return tokens
}

export const appleJournalImporter: Importer = {
  id: 'apple-journal',
  name: 'Apple Journal',
  descriptionKey: 'import.sources.apple-journal',
  fileSpec: {
    label: 'Apple Journal export',
    extensions: ['html', 'htm'],
    allowMultiple: true
  },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    ctx.setPhase('importing')
    const total = input.sourcePaths.length
    let done = 0

    for (const filePath of input.sourcePaths) {
      if (ctx.isCancelled()) break

      const basename = path.basename(filePath)
      if (basename === 'index.html' || basename === 'index.htm') {
        ctx.reportSkipped(filePath, 'index file')
        done++
        ctx.reportProgress(done, total)
        continue
      }

      try {
        ctx.status(importingItemStatus(basename))
        const html = await readFile(filePath, 'utf8')
        const doc = new JSDOM(html).window.document

        // Extract date from .pageHeader
        const headerEl = doc.querySelector('.pageHeader')
        const headerText = headerEl?.textContent?.trim() ?? ''
        const parsed = parseJournalDate(headerText)
        const date = parsed?.iso ?? null

        // Extract reflection prompt text separately for blockquote
        const reflectionEl = doc.querySelector('.reflectionPrompt')
        const reflection = reflectionEl?.textContent?.trim() ?? null

        // Build body markdown from paragraphs only (reflection added by mapEntry)
        const bodyContainer = doc.createElement('div')
        // Collect body paragraphs in a single pass so document order is preserved
        // (Apple assigns .p2/.p3 by paragraph style, not sequence — a two-pass
        // ['.p2','.p3'] collection would reorder the entry text).
        doc.querySelectorAll('.p2, .p3').forEach((el) => {
          bodyContainer.appendChild(el.cloneNode(true))
        })
        const { markdown: bodyMarkdown } = htmlToMarkdown(bodyContainer)

        // Collect metadata tokens from asset grid (ignoring media)
        const tokens = collectTokens(doc)

        const filenameStem = path.basename(filePath, path.extname(filePath))
        const plan = mapEntry({
          date,
          bodyMarkdown,
          reflection,
          overlayValues: tokens,
          filenameStem
        })

        await createNote({
          title: plan.title,
          content: plan.content,
          folder: plan.folder,
          properties: plan.properties,
          created: plan.created
        })
        ctx.reportImported()
      } catch (error) {
        logger.warn('apple journal entry import failed', { filePath })
        ctx.reportFailed(filePath, error)
      }

      done++
      ctx.reportProgress(done, total)
    }

    ctx.setPhase('done')
    return ctx.toSummary()
  }
}
