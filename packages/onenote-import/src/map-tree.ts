/**
 * Map a flat OneNote notebook/section/page hierarchy into a list of
 * {@link PagePlan}s, each carrying the vault folder it should land in.
 *
 * Pure: takes the already-fetched Graph entities and produces the plan with no
 * I/O. The desktop importer is responsible for the actual Graph pagination.
 *
 * @module onenote-import/map-tree
 */

import type { OneNoteNotebook, OneNotePage, OneNoteSection, PagePlan } from './types.ts'

const ROOT = 'OneNote'

/**
 * Sanitize a notebook/section name into a single vault folder segment. Mirrors
 * the conservative stripping used elsewhere in import: drop path separators and
 * reserved filename characters, collapse whitespace (spaces kept). Empty → `Untitled`.
 */
function folderSegment(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : 'Untitled'
}

/**
 * Build the per-page import plan.
 *
 * @param notebooks - Notebooks fetched from Graph.
 * @param sections - Sections fetched from Graph (each references its notebook).
 * @param pages - Pages fetched from Graph (each references its section).
 * @returns One {@link PagePlan} per page whose section + notebook are present,
 *   in input order. Pages whose section or notebook is missing are dropped.
 */
export function mapTree(
  notebooks: OneNoteNotebook[],
  sections: OneNoteSection[],
  pages: OneNotePage[]
): PagePlan[] {
  const notebookById = new Map(notebooks.map((n) => [n.id, n]))
  const sectionById = new Map(sections.map((s) => [s.id, s]))

  const plans: PagePlan[] = []
  for (const page of pages) {
    const section = sectionById.get(page.sectionId)
    if (!section) continue
    const notebook = notebookById.get(section.notebookId)
    if (!notebook) continue

    const folder = `${ROOT}/${folderSegment(notebook.displayName)}/${folderSegment(
      section.displayName
    )}`

    plans.push({
      pageId: page.id,
      title: page.title.trim() || 'Untitled',
      folder,
      ...(page.createdDateTime ? { created: page.createdDateTime } : {})
    })
  }
  return plans
}
