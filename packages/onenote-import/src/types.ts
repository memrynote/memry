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
}

/** A OneNote page (Graph `/sections/{id}/pages` item). */
export interface OneNotePage {
  id: string
  title: string
  /** Parent section id. */
  sectionId: string
  /** ISO timestamp of page creation, if known. */
  createdDateTime?: string
}

/** One page entry in the import plan, with its resolved vault folder. */
export interface PagePlan {
  pageId: string
  title: string
  /** Vault folder path, e.g. `OneNote/<notebook>/<section>`. */
  folder: string
  /** ISO creation timestamp, carried through from the Graph page. */
  created?: string
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
