/**
 * protobufjs JSON descriptor for the Apple Notes note body.
 *
 * Ported from the Obsidian Apple Notes importer (MIT, Three Planets Software).
 * Only the message graph reachable from `ciofecaforensics.Document` is kept,
 * which is everything required to decode a note body (Document → Note →
 * AttributeRun → ParagraphStyle/Font/Color/AttachmentInfo). The mergeable-data
 * CRDT messages used for tables/scans are intentionally omitted; those
 * attachment types are deferred (see convert-doc.ts).
 *
 * Feed this to `protobufjs.Root.fromJSON(descriptor)`.
 */

import type { INamespace } from 'protobufjs'

export const descriptor: INamespace = {
  nested: {
    ciofecaforensics: {
      nested: {
        Color: {
          fields: {
            red: { type: 'float', id: 1 },
            green: { type: 'float', id: 2 },
            blue: { type: 'float', id: 3 },
            alpha: { type: 'float', id: 4 }
          }
        },
        AttachmentInfo: {
          fields: {
            attachmentIdentifier: { type: 'string', id: 1 },
            typeUti: { type: 'string', id: 2 }
          }
        },
        Font: {
          fields: {
            fontName: { type: 'string', id: 1 },
            pointSize: { type: 'float', id: 2 },
            fontHints: { type: 'int32', id: 3 }
          }
        },
        ParagraphStyle: {
          fields: {
            styleType: { type: 'int32', id: 1, options: { default: -1 } },
            alignment: { type: 'int32', id: 2 },
            indentAmount: { type: 'int32', id: 4 },
            checklist: { type: 'Checklist', id: 5 },
            blockquote: { type: 'int32', id: 8 }
          }
        },
        Checklist: {
          fields: {
            uuid: { type: 'bytes', id: 1 },
            done: { type: 'int32', id: 2 }
          }
        },
        AttributeRun: {
          fields: {
            length: { type: 'int32', id: 1 },
            paragraphStyle: { type: 'ParagraphStyle', id: 2 },
            font: { type: 'Font', id: 3 },
            fontWeight: { type: 'int32', id: 5 },
            underlined: { type: 'int32', id: 6 },
            strikethrough: { type: 'int32', id: 7 },
            superscript: { type: 'int32', id: 8 },
            link: { type: 'string', id: 9 },
            color: { type: 'Color', id: 10 },
            attachmentInfo: { type: 'AttachmentInfo', id: 12 }
          }
        },
        NoteStoreProto: {
          fields: {
            document: { type: 'Document', id: 2 }
          }
        },
        Document: {
          fields: {
            version: { type: 'int32', id: 2 },
            note: { type: 'Note', id: 3 }
          }
        },
        Note: {
          fields: {
            noteText: { type: 'string', id: 2 },
            attributeRun: {
              rule: 'repeated',
              type: 'AttributeRun',
              id: 5,
              options: { packed: false }
            }
          }
        }
      }
    }
  }
}

/** Fully-qualified protobuf type name for a decoded note document. */
export const DOCUMENT_TYPE = 'ciofecaforensics.Document'
