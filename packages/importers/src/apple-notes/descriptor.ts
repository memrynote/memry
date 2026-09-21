/**
 * protobufjs JSON descriptor for the Apple Notes note body.
 *
 * Ported from the Three Planets Software Apple Notes importer (MIT).
 * Two message graphs are kept:
 *
 * - `ciofecaforensics.Document` — a note body (Document → Note → AttributeRun →
 *   ParagraphStyle/Font/Color/AttachmentInfo).
 * - `ciofecaforensics.MergableDataProto` — the CRDT container a table
 *   attachment stores in ICAttachment.ZMERGEABLEDATA1. Its cells are ordinary
 *   `Note` messages, which is why the two graphs share one descriptor
 *   (see decode-table.ts).
 *
 * Scans, drawings and handwriting are still deferred (see convert-doc.ts).
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
        },

        // ---- Mergeable data (CRDT): tables ----
        // Every reference inside the container is an index into one of the
        // key/type/uuid/entry lists on MergeableDataObjectData.
        ObjectID: {
          fields: {
            unsignedIntegerValue: { type: 'uint64', id: 2 },
            stringValue: { type: 'string', id: 4 },
            objectIndex: { type: 'int32', id: 6 }
          }
        },
        DictionaryElement: {
          fields: {
            key: { type: 'ObjectID', id: 1 },
            value: { type: 'ObjectID', id: 2 }
          }
        },
        Dictionary: {
          fields: {
            element: {
              rule: 'repeated',
              type: 'DictionaryElement',
              id: 1,
              options: { packed: false }
            }
          }
        },
        RegisterLatest: {
          fields: {
            contents: { type: 'ObjectID', id: 2 }
          }
        },
        MapEntry: {
          fields: {
            key: { type: 'int32', id: 1 },
            value: { type: 'ObjectID', id: 2 }
          }
        },
        MergeableDataObjectMap: {
          fields: {
            type: { type: 'int32', id: 1 },
            mapEntry: { rule: 'repeated', type: 'MapEntry', id: 3, options: { packed: false } }
          }
        },
        OrderedSetOrderingArrayAttachment: {
          fields: {
            index: { type: 'int32', id: 1 },
            uuid: { type: 'bytes', id: 2 }
          }
        },
        OrderedSetOrderingArray: {
          fields: {
            contents: { type: 'Note', id: 1 },
            attachment: {
              rule: 'repeated',
              type: 'OrderedSetOrderingArrayAttachment',
              id: 2,
              options: { packed: false }
            }
          }
        },
        OrderedSetOrdering: {
          fields: {
            array: { type: 'OrderedSetOrderingArray', id: 1 },
            contents: { type: 'Dictionary', id: 2 }
          }
        },
        OrderedSet: {
          fields: {
            ordering: { type: 'OrderedSetOrdering', id: 1 },
            elements: { type: 'Dictionary', id: 2 }
          }
        },
        MergeableDataObjectEntry: {
          fields: {
            registerLatest: { type: 'RegisterLatest', id: 1 },
            dictionary: { type: 'Dictionary', id: 6 },
            note: { type: 'Note', id: 10 },
            customMap: { type: 'MergeableDataObjectMap', id: 13 },
            orderedSet: { type: 'OrderedSet', id: 16 }
          }
        },
        MergeableDataObjectData: {
          fields: {
            mergeableDataObjectEntry: {
              rule: 'repeated',
              type: 'MergeableDataObjectEntry',
              id: 3,
              options: { packed: false }
            },
            mergeableDataObjectKeyItem: { rule: 'repeated', type: 'string', id: 4 },
            mergeableDataObjectTypeItem: { rule: 'repeated', type: 'string', id: 5 },
            mergeableDataObjectUuidItem: { rule: 'repeated', type: 'bytes', id: 6 }
          }
        },
        MergableDataObject: {
          fields: {
            version: { type: 'int32', id: 2 },
            mergeableDataObjectData: { type: 'MergeableDataObjectData', id: 3 }
          }
        },
        MergableDataProto: {
          fields: {
            mergableDataObject: { type: 'MergableDataObject', id: 2 }
          }
        }
      }
    }
  }
}

/** Fully-qualified protobuf type name for a decoded note document. */
export const DOCUMENT_TYPE = 'ciofecaforensics.Document'

/** Fully-qualified protobuf type name for a mergeable-data (table) payload. */
export const MERGEABLE_DATA_TYPE = 'ciofecaforensics.MergableDataProto'
