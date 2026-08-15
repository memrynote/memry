/**
 * Decides whether a markdown file may become an editable, CRDT-seeded note.
 *
 * The BlockNote markdown parse is roughly quadratic in the size of a single
 * block, not in the size of the file. Measured on real files:
 *
 *   1.81 MB, blank-line separated (124 blocks)  ->    477 ms
 *   1.81 MB, as-is                (1 block)     ->  6 594 ms   (14x)
 *   2.73 MB, as-is                (2 blocks)    ->  8 936 ms
 *
 * Identical bytes; only the block shape differs. Log dumps carry no blank
 * lines, so remark parses the whole file as one paragraph holding millions of
 * inline nodes.
 *
 * That is why classification needs *both* bounds. A byte ceiling alone
 * misclassifies in both directions: it rejects a well-formed 3 MB note that
 * parses fine, and accepts a 900 KB log dump that does not.
 */

/** Files above this never become notes. Checked against `stat`, before any read. */
export const NOTE_MAX_BYTES = 2 * 1024 * 1024

/** Largest blank-line-separated block a note may contain. */
export const NOTE_MAX_BLOCK_BYTES = 128 * 1024

export type MarkdownSizeClass = 'note' | 'large-file'

/** Which bound pushed a file out of note class. */
export type LargeFileReason = 'file-bytes' | 'block-bytes'

interface MarkdownMeasurements {
  fileBytes: number
  /** Null when the file was classified on size alone and never read. */
  largestBlockBytes: number | null
}

/**
 * Discriminated on `sizeClass` so `reason` narrows to a real bound wherever a
 * caller has already established the file is large-file class.
 */
export type MarkdownClassification =
  | (MarkdownMeasurements & { sizeClass: 'note'; reason: null })
  | (MarkdownMeasurements & { sizeClass: 'large-file'; reason: LargeFileReason })

/** The large-file arm on its own, for callers that have already decided. */
export type LargeFileClassification = Extract<MarkdownClassification, { sizeClass: 'large-file' }>

export interface MarkdownClassThresholds {
  maxFileBytes?: number
  maxBlockBytes?: number
}

/** UTF-8 byte length, without allocating an encoded copy of the string. */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      // A full surrogate pair is one astral code point.
      bytes += 4
      i++
    } else {
      // Includes an unpaired surrogate, which encodes as U+FFFD.
      bytes += 3
    }
  }
  return bytes
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

interface MarkdownScan {
  fileBytes: number
  largestBlockBytes: number
}

/**
 * One pass over the text, measuring total bytes and the largest
 * blank-line-separated block together.
 */
function scanMarkdown(markdown: string): MarkdownScan {
  let fileBytes = 0
  let largestBlockBytes = 0
  let blockBytes = 0
  let lineBytes = 0
  let lineIsBlank = true

  const endLine = (): void => {
    if (lineIsBlank) {
      // A blank line closes the block; the blank line itself belongs to neither.
      if (blockBytes > largestBlockBytes) largestBlockBytes = blockBytes
      blockBytes = 0
    } else {
      // The newline joining this line to the previous one is interior to the
      // block, so it only counts once the block is already non-empty.
      if (blockBytes > 0) blockBytes += 1
      blockBytes += lineBytes
    }
    lineBytes = 0
    lineIsBlank = true
  }

  for (let i = 0; i < markdown.length; i++) {
    const code = markdown.charCodeAt(i)

    if (code === 0x0a) {
      fileBytes += 1
      endLine()
      continue
    }

    let charBytes: number
    if (code < 0x80) {
      charBytes = 1
    } else if (code < 0x800) {
      charBytes = 2
    } else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(markdown.charCodeAt(i + 1))) {
      charBytes = 4
      i++
    } else {
      charBytes = 3
    }

    fileBytes += charBytes
    lineBytes += charBytes
    // Space, tab and carriage return do not make a line non-blank.
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d) lineIsBlank = false
  }

  endLine()
  if (blockBytes > largestBlockBytes) largestBlockBytes = blockBytes

  return { fileBytes, largestBlockBytes }
}

/**
 * Byte length of the largest blank-line-separated segment.
 *
 * A blank line is one holding nothing but spaces, tabs or a carriage return.
 * Fenced code blocks containing blank lines are split by this scan even though
 * remark keeps them whole — that under-reports, which is safe: the quadratic
 * cost comes from inline parsing inside paragraphs, and code fences carry no
 * inline nodes.
 */
export function largestBlockByteLength(markdown: string): number {
  return scanMarkdown(markdown).largestBlockBytes
}

/**
 * Classify from `stat` alone, before reading the file.
 *
 * Returns a classification when the byte ceiling alone settles it, and null
 * when the file is small enough that the block bound still has to be measured
 * against its content.
 */
export function classifyMarkdownStat(
  fileBytes: number,
  thresholds?: MarkdownClassThresholds
): LargeFileClassification | null {
  const maxFileBytes = thresholds?.maxFileBytes ?? NOTE_MAX_BYTES
  if (fileBytes <= maxFileBytes) return null

  return {
    sizeClass: 'large-file',
    reason: 'file-bytes',
    fileBytes,
    largestBlockBytes: null
  }
}

/** Classify from the full text, measuring both bounds in one pass. */
export function classifyMarkdownContent(
  markdown: string,
  thresholds?: MarkdownClassThresholds
): MarkdownClassification {
  const maxFileBytes = thresholds?.maxFileBytes ?? NOTE_MAX_BYTES
  const maxBlockBytes = thresholds?.maxBlockBytes ?? NOTE_MAX_BLOCK_BYTES
  const { fileBytes, largestBlockBytes } = scanMarkdown(markdown)

  // File size is reported first: it is the cheaper bound and the one a caller
  // can also reach from `stat` alone.
  if (fileBytes > maxFileBytes) {
    return { sizeClass: 'large-file', reason: 'file-bytes', fileBytes, largestBlockBytes }
  }
  if (largestBlockBytes > maxBlockBytes) {
    return { sizeClass: 'large-file', reason: 'block-bytes', fileBytes, largestBlockBytes }
  }
  return { sizeClass: 'note', reason: null, fileBytes, largestBlockBytes }
}
