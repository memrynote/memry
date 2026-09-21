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

/**
 * A decoded Apple Notes table: cells in row-major order, already converted to
 * inline markdown. Rows are padded to the table's column count.
 */
export interface DecodedTable {
  rows: string[][]
}

/**
 * Keys of the ICTable mergeable-data map. Entries reference these by index into
 * `MergeableDataObjectData.mergeableDataObjectKeyItem`.
 */
export const AN_TABLE_KEY = {
  /** Row ordering (an ordered set of row uuids). */
  Rows: 'crRows',
  /** Column ordering (an ordered set of column uuids). */
  Columns: 'crColumns',
  /** Cell contents, keyed column uuid → row uuid → note. */
  CellColumns: 'cellColumns',
  /** Index into the uuid list, held by the CRDT's NSUUID wrapper objects. */
  UuidIndex: 'UUIDIndex'
} as const

/** Mergeable-data object types; only the table root is matched by name. */
export const AN_TABLE_TYPE = {
  ICTable: 'com.apple.notes.ICTable'
} as const

/** A CRDT reference: either an inline value or an index into the entry list. */
export interface ANObjectId {
  unsignedIntegerValue?: number
  stringValue?: string
  objectIndex?: number
}

export interface ANDictionary {
  element?: { key?: ANObjectId; value?: ANObjectId }[]
}

/** A typed map; `type` indexes the type list, `mapEntry[].key` the key list. */
export interface ANObjectMap {
  type?: number
  mapEntry?: { key?: number; value?: ANObjectId }[]
}

export interface ANOrderedSet {
  ordering?: {
    array?: { attachment?: { index?: number; uuid?: Uint8Array }[] }
    contents?: ANDictionary
  }
}

/** One entry of the mergeable-data object list (only the used variants). */
export interface ANMergeableObject {
  dictionary?: ANDictionary
  note?: { noteText?: string; attributeRun?: AttributeRun[] }
  customMap?: ANObjectMap
  orderedSet?: ANOrderedSet
}

/** The decoded `MergeableDataObjectData` payload of a table attachment. */
export interface ANMergeableData {
  mergeableDataObjectEntry?: ANMergeableObject[]
  mergeableDataObjectKeyItem?: string[]
  mergeableDataObjectTypeItem?: string[]
  mergeableDataObjectUuidItem?: Uint8Array[]
}

/** Result of converting a decoded note into markdown. */
export interface ConvertedNote {
  markdown: string
  /** Inline attachment identifiers referenced by the note, in order. */
  attachmentIds: string[]
}

/** Inline attachment UTIs handled (or explicitly deferred) by the converter. */
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
