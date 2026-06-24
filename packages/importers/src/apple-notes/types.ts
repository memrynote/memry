/**
 * Decoded Apple Notes document types. These mirror the protobuf message shapes
 * (see descriptor.ts) but only expose the fields the converter needs.
 */

/** Paragraph style types used by Apple Notes (ParagraphStyle.styleType). */
export enum ANStyleType {
  Default = -1,
  Title = 0,
  Heading = 1,
  Subheading = 2,
  Monospaced = 4,
  DottedList = 100,
  DashedList = 101,
  NumberedList = 102,
  Checkbox = 103
}

/** Font weight flags (AttributeRun.fontWeight). */
export enum ANFontWeight {
  Regular = 0,
  Bold = 1,
  Italic = 2,
  BoldItalic = 3
}

export interface ANChecklist {
  done?: number
}

export interface ANParagraphStyle {
  styleType?: number
  alignment?: number
  indentAmount?: number
  checklist?: ANChecklist
  blockquote?: number
}

export interface ANAttachmentInfo {
  attachmentIdentifier?: string
  typeUti?: string
}

/** A single run of text sharing the same formatting attributes. */
export interface AttributeRun {
  length: number
  paragraphStyle?: ANParagraphStyle
  fontWeight?: number
  underlined?: number
  strikethrough?: number
  superscript?: number
  link?: string
  attachmentInfo?: ANAttachmentInfo
}

/** A decoded note body: the raw text plus its attribute runs. */
export interface DecodedNote {
  text: string
  runs: AttributeRun[]
}

/** Result of converting a decoded note into markdown. */
export interface ConvertedNote {
  markdown: string
  /** Inline attachment identifiers referenced by the note, in order. */
  attachmentIds: string[]
}

/** Inline attachment UTIs handled (or explicitly skipped) by the converter. */
export const AN_ATTACHMENT_UTI = {
  Hashtag: 'com.apple.notes.inlinetextattachment.hashtag',
  Mention: 'com.apple.notes.inlinetextattachment.mention',
  InternalLink: 'com.apple.notes.inlinetextattachment.link',
  Table: 'com.apple.notes.table',
  UrlCard: 'public.url',
  Drawing: 'com.apple.paper',
  DrawingLegacy: 'com.apple.drawing',
  DrawingLegacy2: 'com.apple.drawing.2',
  Scan: 'com.apple.notes.gallery',
  ModifiedScan: 'com.apple.paper.doc.scan'
} as const
