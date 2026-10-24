/**
 * What a file tab remembers, and how it is read back.
 *
 * Every value here is ENTITY-STAMPED (`useTabEntityViewState`): a preview file
 * tab keeps its id, its viewState and its mounted viewer while the file inside
 * it changes, so page 12 of a three-page PDF, or a zoom fitted to another
 * image, would otherwise be applied to the next file the user clicks.
 *
 * Deliberately not stored: whether the media is PLAYING. Restoring a tab must
 * not start making noise, so the position comes back and the transport stays
 * paused.
 */

export const FILE_VIEW_STATE_KEYS = {
  /** PDF: the page the main pane is showing. This IS the reading position. */
  pdfPage: 'filePdfPage',
  pdfScale: 'filePdfScale',
  pdfRotation: 'filePdfRotation',
  pdfSidebarOpen: 'filePdfSidebarOpen',
  /**
   * Which axis the page is fitted across, or `null` for "the user picked a
   * zoom". This — not `pdfScale` — is what says whether the viewer refits when
   * the pane changes width.
   */
  pdfFitMode: 'filePdfFitMode',
  /** Single page, or a two-page spread starting on odd or on even pages. */
  pdfPageMode: 'filePdfPageMode',
  /** Image zoom. `null` means "never zoomed" — fit to the container instead. */
  imageScale: 'fileImageScale',
  imageRotation: 'fileImageRotation',
  imagePosition: 'fileImagePosition',
  /** Playback position in seconds. Never auto-resumed. */
  audioPosition: 'fileAudioPosition',
  videoPosition: 'fileVideoPosition'
} as const

/**
 * The PDF main pane renders ONE page at a time, so an offset inside it only
 * means anything on the page it was measured on. The entity stamp guards the
 * file; the page has to be in the key.
 */
export const pdfPageScrollKey = (page: number): string => `file-pdf-page:${page}`

/** The audio player's transcript pane. */
export const FILE_AUDIO_SCROLL_KEY = 'file-audio'

/** Pages are 1-based and there is no such thing as page 0. */
export const parsePdfPage = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : undefined

/** A zoom factor. `0` and negatives would render nothing at all. */
export const parseScale = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined

/** Zoom, or `null` for "the user has never zoomed this". */
export const parseNullableScale = (raw: unknown): number | null | undefined =>
  raw === null ? null : parseScale(raw)

/** Only the four quarter turns the rotate button can produce. */
export const parseRotation = (raw: unknown): number | undefined =>
  raw === 0 || raw === 90 || raw === 180 || raw === 270 ? raw : undefined

/** Fit across the pane's width, down its height, or not at all. */
export type PdfFitMode = 'width' | 'height' | null

/**
 * What the tab stores. `'unset'` is a real value rather than an absence: a
 * `parse` that returns `undefined` REJECTS the entry, so "no fit mode written
 * yet" cannot be spelled `undefined` here.
 */
export type StoredPdfFitMode = PdfFitMode | 'unset'

export const parseStoredPdfFitMode = (raw: unknown): StoredPdfFitMode | undefined =>
  raw === 'unset' || raw === null || raw === 'width' || raw === 'height' ? raw : undefined

/**
 * `two-odd` puts odd pages on the left (1-2, 3-4); `two-even` puts even pages
 * there and leaves page 1 on its own, the way a book's cover sits alone.
 */
export type PdfPageMode = 'single' | 'two-odd' | 'two-even'

export const parsePdfPageMode = (raw: unknown): PdfPageMode | undefined =>
  raw === 'single' || raw === 'two-odd' || raw === 'two-even' ? raw : undefined

/**
 * The fit a tab written before {@link FILE_VIEW_STATE_KEYS.pdfFitMode} existed
 * should come back with. Those tabs encoded "never zoomed, so keep fitting" as
 * a `null` scale, which is exactly what fit-to-width means now.
 */
export const resolveLegacyFitMode = (
  storedFitMode: StoredPdfFitMode,
  storedScale: number | null
): PdfFitMode => (storedFitMode !== 'unset' ? storedFitMode : storedScale === null ? 'width' : null)

/**
 * The first page of the spread that shows `page`.
 *
 * Snapping to the spread's start is what keeps the parity stable: without it a
 * jump to page 51 in an even-start document would re-split every spread after
 * it and show each page twice.
 */
export function pdfSpreadStart(page: number, mode: PdfPageMode): number {
  if (mode === 'single') return page
  if (mode === 'two-odd') return page % 2 === 1 ? page : page - 1
  if (page <= 1) return 1
  return page % 2 === 0 ? page : page - 1
}

/** The pages the spread starting at `start` shows, clamped to the document. */
export function pdfSpreadPages(start: number, mode: PdfPageMode, numPages: number): number[] {
  if (mode === 'single') return [start]
  // An even-start document opens on page 1 alone, so it has no partner.
  if (mode === 'two-even' && start === 1) return [1]
  return [start, start + 1].filter((page) => page <= numPages)
}

export const parseViewerBoolean = (raw: unknown): boolean | undefined =>
  typeof raw === 'boolean' ? raw : undefined

export interface ViewerPosition {
  x: number
  y: number
}

export const parseViewerPosition = (raw: unknown): ViewerPosition | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as { x?: unknown; y?: unknown }
  if (typeof record.x !== 'number' || !Number.isFinite(record.x)) return undefined
  if (typeof record.y !== 'number' || !Number.isFinite(record.y)) return undefined
  return { x: record.x, y: record.y }
}

/** Seconds into the track. `0` is the start, which is a position like any other. */
export const parsePlaybackPosition = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined

/**
 * Whether a stored playback position is worth seeking to.
 *
 * A position at or past the end is what "played to the end" leaves behind, and
 * seeking there reopens the file on its last frame with nothing left to play.
 * A duration that is not known yet (0, NaN for a stream) means the media cannot
 * be seeked reliably at all.
 */
export function shouldResumePlayback(position: number, duration: number): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false
  if (position <= 0) return false
  return position < duration - 1
}
