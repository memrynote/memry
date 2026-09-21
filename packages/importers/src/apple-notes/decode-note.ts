/**
 * Decode an already-decompressed Apple Notes protobuf body into text + runs.
 *
 * The desktop importer is responsible for gzip decompression (zlib lives in
 * Node, not here) — this module is pure protobuf so it stays testable with
 * synthetic fixtures and free of fs/zlib/sqlite.
 */

import { DOCUMENT_TYPE } from './descriptor.ts'
import { lookupAppleNotesType } from './root.ts'
import type { AttributeRun, DecodedNote } from './types.ts'

/**
 * Decode the protobuf bytes of a note body.
 *
 * @param protobufBytes already-gunzipped `ciofecaforensics.Document` bytes
 * @returns the note text and its attribute runs (empty when the note is blank)
 */
export function decodeNote(protobufBytes: Uint8Array): DecodedNote {
  const Document = lookupAppleNotesType(DOCUMENT_TYPE)
  const message = Document.decode(protobufBytes)
  const obj = Document.toObject(message, {
    defaults: true,
    arrays: true,
    objects: true
  }) as {
    note?: { noteText?: string; attributeRun?: AttributeRun[] }
  }

  const note = obj.note ?? {}
  return {
    text: note.noteText ?? '',
    runs: Array.isArray(note.attributeRun) ? note.attributeRun : []
  }
}
