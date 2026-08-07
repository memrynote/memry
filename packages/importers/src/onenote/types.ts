/**
 * Types for the OneNote import transform.
 *
 * Pure data shapes — no network, no jsdom, no electron / fs / db dependencies.
 * The desktop importer fetches notebooks/sections/pages from the Microsoft
 * Graph API and feeds these flat shapes into {@link mapTree}.
 */

/** A OneNote notebook (Graph `/me/onenote/notebooks` item). */
export interface OneNoteNotebook {
  id: string
  displayName: string
}

/** A OneNote section (Graph `/notebooks/{id}/sections` item). */
export interface OneNoteSection {
  id: string
  displayName: string
  /** Parent notebook id. */
  notebookId: string
  /** Display names of the section groups between the notebook and this section. */
  groupPath?: string[]
}

/** A OneNote page (Graph `/sections/{id}/pages` item). */
export interface OneNotePage {
  id: string
  title: string
  /** Parent section id. */
  sectionId: string
  /** ISO timestamp of page creation, if known. */
  createdDateTime?: string
  /** ISO timestamp of the last page edit, if known. */
  lastModifiedDateTime?: string
  /** Indentation level (0 = top level, 1–2 = subpage). Needs `pagelevel=true`. */
  level?: number
}

/** One page entry in the import plan, with its resolved vault folder. */
export interface PagePlan {
  pageId: string
  title: string
  /** Vault folder path, e.g. `OneNote/<notebook>/<section group…>/<section>`. */
  folder: string
  /** ISO creation timestamp, carried through from the Graph page. */
  created?: string
  /** ISO last-modified timestamp, carried through from the Graph page. */
  modified?: string
}

/** Result of {@link preparePageHtml} (a pure, jsdom-free pre-pass). */
export interface PreparedPageHtml {
  html: string
}

/** One image lifted out of page HTML by {@link extractDataImages}. */
export interface ExtractedImage {
  /** Token left in the HTML in place of the data URI (e.g. `onenote-img-0`). */
  placeholder: string
  /** Base64 payload (no `data:` prefix). */
  base64: string
  /** MIME type from the data URI (e.g. `image/png`). */
  mime: string
}

/** Result of {@link extractDataImages}. */
export interface ExtractedImagesResult {
  html: string
  images: ExtractedImage[]
}

/** The two parts of a Graph `/pages/{id}/content?includeInkML=true` response. */
export interface OneNotePageContentParts {
  html: string
  inkml: string
}

/** A section entry as shown in the renderer's notebook picker. */
export interface OneNoteSectionSummary {
  id: string
  displayName: string
}

/** A section group node in the renderer's notebook picker tree. */
export interface OneNoteSectionGroupTreeNode {
  id: string
  displayName: string
  sections: OneNoteSectionSummary[]
  sectionGroups: OneNoteSectionGroupTreeNode[]
}

/** A notebook node in the renderer's notebook picker tree. */
export interface OneNoteNotebookTreeNode {
  id: string
  displayName: string
  sections: OneNoteSectionSummary[]
  sectionGroups: OneNoteSectionGroupTreeNode[]
}

/** Parsed importer options (the renderer sends them as a plain record). */
export interface OneNoteImportOptions {
  /** Section ids to import; `null` imports every section. */
  sectionIds: string[] | null
  /**
   * Also save attachments Memry cannot embed natively (presentations, media,
   * archives — never executables). Default false: only native types import.
   */
  includeIncompatibleAttachments: boolean
  /** Skip pages recorded as imported by a previous OneNote run. Default true. */
  skipPreviouslyImported: boolean
}

/** Parse the untyped `options` record from the import IPC boundary. */
export function parseOneNoteImportOptions(
  raw: Record<string, unknown> | undefined
): OneNoteImportOptions {
  const sectionIdsRaw = raw?.sectionIds
  // An explicit (even empty) list means "these sections"; only an absent list
  // means "everything". Collapsing empty to null would import the whole
  // account when the caller selected nothing.
  const sectionIds = Array.isArray(sectionIdsRaw)
    ? sectionIdsRaw.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : null
  return {
    sectionIds,
    includeIncompatibleAttachments: raw?.includeIncompatibleAttachments === true,
    skipPreviouslyImported: raw?.skipPreviouslyImported !== false
  }
}
