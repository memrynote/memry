/**
 * Map a flat OneNote notebook/section/page hierarchy into a list of
 * {@link PagePlan}s, each carrying the vault folder it should land in.
 *
 * Pure: takes the already-fetched Graph entities and produces the plan with no
 * I/O. The desktop importer is responsible for the actual Graph pagination.
 *
 * Folder layout: `OneNote/<notebook>/<section group…>/<section>`, and subpages
 * (Graph `level` 1–2) nest under their parent page's title. A parent page that
 * has subpages moves into a folder named after itself so the family stays in
 * one directory: `…/Section/Parent/Parent.md` + `…/Section/Parent/Child.md`.
 *
 * @module onenote/map-tree
 */

import type { OneNoteNotebook, OneNotePage, OneNoteSection, PagePlan } from './types.ts'

const ROOT = 'OneNote'

/**
 * Sanitize a notebook/section/page name into a single vault folder segment.
 * Mirrors the conservative stripping used elsewhere in import: drop path
 * separators and reserved filename characters, collapse whitespace (spaces
 * kept). Empty → `Untitled`.
 *
 * Leading dots are stripped so a source name like `..` or `.hidden` cannot
 * traverse out of the import root: these segments are joined into the vault
 * folder path, which the desktop side resolves with a plain `path.join`.
 */
function folderSegment(name: string): string {
  let cleaned = name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  while (cleaned.startsWith('.')) {
    cleaned = cleaned.slice(1).trim()
  }
  return cleaned.length > 0 ? cleaned : 'Untitled'
}

function pageTitle(page: OneNotePage): string {
  return page.title.trim() || 'Untitled'
}

/**
 * Resolve the folder for every page of one section, honouring subpage levels.
 * Pages must arrive in OneNote's own order (Graph `$orderby=order`), because a
 * subpage's parent is the nearest preceding page with a lower level.
 */
function planSectionPages(pages: OneNotePage[], sectionFolder: string): PagePlan[] {
  const plans: PagePlan[] = []
  /** Ancestor chain of parent pages: title segments with their levels. */
  const parents: { level: number; segment: string }[] = []

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    const level = page.level ?? 0

    while (parents.length > 0 && parents[parents.length - 1].level >= level) {
      parents.pop()
    }

    const next = pages[i + 1]
    const hasSubpages = next !== undefined && (next.level ?? 0) > level

    const segments = parents.map((p) => p.segment)
    if (hasSubpages) {
      // The parent's own file joins its children inside a folder named after it.
      segments.push(folderSegment(pageTitle(page)))
      parents.push({ level, segment: folderSegment(pageTitle(page)) })
    }

    plans.push({
      pageId: page.id,
      title: pageTitle(page),
      folder: [sectionFolder, ...segments].join('/'),
      ...(page.createdDateTime ? { created: page.createdDateTime } : {}),
      ...(page.lastModifiedDateTime ? { modified: page.lastModifiedDateTime } : {})
    })
  }

  return plans
}

/**
 * Build the per-page import plan.
 *
 * @param notebooks - Notebooks fetched from Graph.
 * @param sections - Sections fetched from Graph (each references its notebook
 *   and carries the section-group path between them, if any).
 * @param pages - Pages fetched from Graph in section order (each references its
 *   section). Pages whose section or notebook is missing are dropped.
 */
export function mapTree(
  notebooks: OneNoteNotebook[],
  sections: OneNoteSection[],
  pages: OneNotePage[]
): PagePlan[] {
  const notebookById = new Map(notebooks.map((n) => [n.id, n]))
  const pagesBySection = new Map<string, OneNotePage[]>()
  for (const page of pages) {
    const list = pagesBySection.get(page.sectionId)
    if (list) list.push(page)
    else pagesBySection.set(page.sectionId, [page])
  }

  const plans: PagePlan[] = []
  for (const section of sections) {
    const notebook = notebookById.get(section.notebookId)
    if (!notebook) continue
    const sectionPages = pagesBySection.get(section.id)
    if (!sectionPages || sectionPages.length === 0) continue

    const sectionFolder = [
      ROOT,
      folderSegment(notebook.displayName),
      ...(section.groupPath ?? []).map(folderSegment),
      folderSegment(section.displayName)
    ].join('/')

    plans.push(...planSectionPages(sectionPages, sectionFolder))
  }
  return plans
}
