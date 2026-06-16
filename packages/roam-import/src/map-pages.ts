/**
 * Map Roam pages → an ImportPlan of notes.
 *
 * For each page:
 *   - phase 2 converts its outline to a nested bullet list,
 *   - phase 3 resolves block refs against the prebuilt uid index,
 *   - daily-note pages are re-titled to the canonical journal date format,
 *   - slash-separated titles (`A/B/C`) become nested folders under `Roam`,
 *     with the leaf segment as the note title.
 *
 * Pure: callers pass the parsed `RoamPage[]` and the uid index from phase 1.
 */

import { convertBlocks } from './convert-blocks.ts'
import { resolveRefs } from './resolve-refs.ts'
import { detectDailyNote, formatJournalFilename } from './dates.ts'
import type { BlockIndex, BlockRefMode, ImportPlan, NotePlan, RoamPage } from './types.ts'

const ROOT = 'Roam'

function msToIso(ms: number | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/**
 * Split a Roam page title into a folder path (under Roam) and a leaf title.
 * `A/B/C` → folder `Roam/A/B`, title `C`. Empty segments are dropped.
 */
export function splitTitlePath(title: string): { folder: string; leafTitle: string } {
  const segments = title
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (segments.length <= 1) {
    return { folder: ROOT, leafTitle: title.trim() || title }
  }
  const leafTitle = segments[segments.length - 1]
  const folder = [ROOT, ...segments.slice(0, -1)].join('/')
  return { folder, leafTitle }
}

export function mapPage(
  page: RoamPage,
  index: BlockIndex,
  mode: BlockRefMode = 'fallback'
): NotePlan {
  const isoDate = detectDailyNote(page.title, page.uid)
  const converted = convertBlocks(page.children ?? [])
  const body = resolveRefs(converted, index, mode)

  if (isoDate) {
    // Daily note: canonical title, flat under Roam (date titles have no slashes).
    return {
      title: formatJournalFilename(isoDate),
      body,
      folder: ROOT,
      created: msToIso(page['create-time']),
      modified: msToIso(page['edit-time']),
      isDailyNote: true
    }
  }

  const { folder, leafTitle } = splitTitlePath(page.title)
  return {
    title: leafTitle,
    body,
    folder,
    created: msToIso(page['create-time']),
    modified: msToIso(page['edit-time']),
    isDailyNote: false
  }
}

export function mapPages(
  pages: RoamPage[],
  index: BlockIndex,
  mode: BlockRefMode = 'fallback'
): ImportPlan {
  return { notes: pages.map((page) => mapPage(page, index, mode)) }
}
