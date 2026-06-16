/**
 * Core types for the Evernote .enex import package.
 */

export interface EnexResource {
  /** Raw base64-encoded bytes of the resource. */
  base64: string
  /** MIME type, e.g. "image/png". */
  mime: string
  /** Original filename from <resource-attributes><file-name>, if present. */
  fileName?: string
}

export interface EnexNote {
  title: string
  /** Raw ENML string (XML fragment, including the <en-note> wrapper). */
  contentHtml: string
  /** ISO 8601 string, derived from Evernote YYYYMMDDTHHMMSSZ. */
  created?: string
  /** ISO 8601 string, derived from Evernote YYYYMMDDTHHMMSSZ. */
  updated?: string
  tags: string[]
  resources: EnexResource[]
}
