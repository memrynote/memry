import { createNote, updateNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { forEachZipEntry } from '../_shared/zip'
import { parseInfo, mapNote, rewriteBearLinks } from '@memry/bear-import'
import type { ZipEntry } from '../_shared/zip'

const logger = createLogger('BearImport')

interface NoteStash {
  folderName: string
  mdEntry: ZipEntry
  infoRaw: unknown
  assetEntries: Map<string, ZipEntry>
}

function firstPathComponent(filepath: string): string {
  return filepath.split('/')[0]
}

export const bearImporter: Importer = {
  id: 'bear',
  name: 'Bear',
  descriptionKey: 'import.sources.bear',
  fileSpec: { label: 'Bear export', extensions: ['bear2bk', 'zip'], allowMultiple: true },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    // ---- Pass 1: scan zip, group by textbundle folder ----
    ctx.setPhase('scanning')
    ctx.status('Scanning Bear export…')

    const noteMap = new Map<string, NoteStash>()
    const uidToTitle = new Map<string, string>()

    await forEachZipEntry(input.sourcePaths, ctx.signal, async (entry) => {
      if (ctx.isCancelled()) return

      const folder = firstPathComponent(entry.filepath)
      if (!folder.endsWith('.textbundle')) return

      const folderName = folder.replace(/\.textbundle$/, '')

      if (entry.name === 'text.md') {
        if (!noteMap.has(folder)) {
          noteMap.set(folder, {
            folderName,
            mdEntry: entry,
            infoRaw: null,
            assetEntries: new Map()
          })
        } else {
          const stash = noteMap.get(folder)!
          stash.mdEntry = entry
        }
        ctx.reportProgress(noteMap.size, 0)
        return
      }

      if (entry.name === 'info.json') {
        let infoRaw: unknown = null
        try {
          infoRaw = JSON.parse(await entry.readText())
        } catch {
          infoRaw = null
        }

        if (!noteMap.has(folder)) {
          noteMap.set(folder, {
            folderName,
            mdEntry: undefined as unknown as ZipEntry,
            infoRaw,
            assetEntries: new Map()
          })
        } else {
          noteMap.get(folder)!.infoRaw = infoRaw
        }

        // Pre-build uid → title map (we'll refine title in pass 2, so store uid now)
        const info = parseInfo(infoRaw)
        if (info.uniqueIdentifier) {
          // Placeholder: real title filled in pass 2 after reading md
          uidToTitle.set(info.uniqueIdentifier, folderName)
        }
        return
      }

      // Asset files live under <folder>/assets/
      if (entry.parent.startsWith(`${folder}/`)) {
        if (!noteMap.has(folder)) {
          noteMap.set(folder, {
            folderName,
            mdEntry: undefined as unknown as ZipEntry,
            infoRaw: null,
            assetEntries: new Map()
          })
        }
        noteMap.get(folder)!.assetEntries.set(entry.name, entry)
      }
    })

    if (ctx.isCancelled()) return ctx.toSummary()

    // Refine uidToTitle using actual note titles from md
    // We need a quick pass over md entries to extract titles
    for (const stash of noteMap.values()) {
      if (!stash.mdEntry) continue
      const info = parseInfo(stash.infoRaw)
      if (!info.uniqueIdentifier) continue
      try {
        const md = await stash.mdEntry.readText()
        const mapped = mapNote({ folderName: stash.folderName, md, info })
        uidToTitle.set(info.uniqueIdentifier, mapped.title)
      } catch {
        // Keep folderName as fallback title
      }
    }

    // ---- Pass 2: import each note ----
    ctx.setPhase('importing')
    const total = noteMap.size
    let done = 0

    for (const stash of noteMap.values()) {
      if (ctx.isCancelled()) return ctx.toSummary()

      if (!stash.mdEntry) {
        ctx.reportSkipped(stash.folderName, 'No text.md found')
        done++
        ctx.reportProgress(done, total)
        continue
      }

      try {
        ctx.status(`Importing ${stash.folderName}`)
        const md = await stash.mdEntry.readText()
        const info = parseInfo(stash.infoRaw)
        const mapped = mapNote({ folderName: stash.folderName, md, info })

        const body = rewriteBearLinks(mapped.body, uidToTitle)

        const note = await createNote({
          title: mapped.title,
          content: body,
          folder: mapped.folder,
          tags: mapped.tags,
          created: mapped.created?.toISOString(),
          modified: mapped.modified?.toISOString()
        })
        ctx.reportImported()

        // Save assets and rewrite refs
        let rewritten = body
        const seenAssets = new Set<string>()

        for (const assetFilename of mapped.assetRefs) {
          if (seenAssets.has(assetFilename)) continue
          seenAssets.add(assetFilename)

          const assetEntry = stash.assetEntries.get(assetFilename)
          if (!assetEntry) continue

          const bytes = await assetEntry.read()
          const result = await saveAttachment(note.id, bytes, assetFilename)
          if (result.success && result.path) {
            rewritten = rewritten.split(`](assets/${assetFilename})`).join(`](${result.path})`)
            ctx.reportAttachment()
          } else {
            ctx.reportSkipped(assetFilename, result.error)
          }
        }

        if (rewritten !== body) {
          await updateNote({ id: note.id, content: rewritten })
        }
      } catch (error) {
        logger.warn('bear note import failed', { folder: stash.folderName, error })
        ctx.reportFailed(stash.folderName, error)
      }

      done++
      ctx.reportProgress(done, total)
    }

    return ctx.toSummary()
  }
}
