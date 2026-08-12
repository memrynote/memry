/**
 * Scanned NotePlan files → an import plan.
 *
 * Daily calendar files become journal entries (Memry's journal is day-keyed);
 * every other calendar period, every regular note and every archived note
 * becomes an ordinary note under `NotePlan/`.
 *
 * Pure — no fs access.
 */

import * as path from 'path'
import { classifyCalendarStem } from './calendar-dates.ts'
import type { NotePlanImportPlan, PlannedNote, PlannedJournal, ScannedFile } from './types.ts'

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md'])

const ROOT_FOLDER = 'NotePlan'
const CALENDAR_FOLDER = `${ROOT_FOLDER}/Calendar`
const ARCHIVE_FOLDER = `${ROOT_FOLDER}/Archive`

/** `10 - Projects/x.txt` under `notes` → `NotePlan/10 - Projects`. */
function noteFolder(relPath: string, base: string): string {
  const dir = path.dirname(relPath)
  if (dir === '.') return base
  return `${base}/${dir}`
}

export function mapFiles(files: ScannedFile[]): NotePlanImportPlan {
  const notes: PlannedNote[] = []
  const journals: PlannedJournal[] = []
  const skipped: NotePlanImportPlan['skipped'] = []

  for (const file of files) {
    const ext = path.extname(file.relPath).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      skipped.push({ item: file.relPath, reason: 'Unsupported file type' })
      continue
    }

    const stem = path.basename(file.relPath, ext)

    if (file.area === 'calendar') {
      const calendar = classifyCalendarStem(stem)
      if (!calendar) {
        skipped.push({ item: file.relPath, reason: 'Not a NotePlan calendar filename' })
        continue
      }
      if (calendar.kind === 'day' && calendar.iso) {
        journals.push({ absPath: file.absPath, rootDir: file.rootDir, date: calendar.iso })
        continue
      }
      // Weekly / monthly / quarterly / yearly have no journal equivalent.
      notes.push({
        absPath: file.absPath,
        rootDir: file.rootDir,
        title: calendar.label,
        vaultFolder: CALENDAR_FOLDER
      })
      continue
    }

    const base = file.area === 'archive' ? ARCHIVE_FOLDER : ROOT_FOLDER
    notes.push({
      absPath: file.absPath,
      rootDir: file.rootDir,
      title: stem,
      vaultFolder: noteFolder(file.relPath, base)
    })
  }

  return { notes, journals, skipped }
}
