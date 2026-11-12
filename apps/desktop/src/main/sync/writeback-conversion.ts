/**
 * The conversion a write-back pass runs: refuse a doc this build cannot
 * serialize, otherwise turn it into the file body.
 *
 * One function for both places it runs, the converter worker
 * (converter-worker.ts) and main when the worker is unavailable
 * (converter-worker-bridge.ts), so the two cannot write different bytes.
 */
import type * as Y from 'yjs'
import type * as BlockNoteConverter from './blocknote-converter'
import type { SourceRestoreOutcome } from './blocknote-converter'
import { serializeNoteBody, type NoteBody } from './writing-markdown'

export type WritebackConversion =
  /** Node types with no schema spec in this build; the file must be kept. */
  | { kind: 'unrepresentable'; nodes: string[] }
  /** `body` is null when conversion failed; the file must be kept. */
  | { kind: 'serialized'; body: NoteBody | null; sourceRestore: SourceRestoreOutcome | null }

export type WritebackConverter = Pick<
  typeof BlockNoteConverter,
  'findUnrepresentableNodes' | 'yDocToMarkdown' | 'yDocToMarkdownWithWritingRanges'
>

export async function convertForWriteback(
  doc: Y.Doc,
  notePath: string,
  readFileBody: () => Promise<string | null>,
  converter: WritebackConverter
): Promise<WritebackConversion> {
  // Checked before serializing, since the answer decides nothing else.
  const unrepresentable = converter.findUnrepresentableNodes(doc)
  if (unrepresentable.length > 0) return { kind: 'unrepresentable', nodes: unrepresentable }

  let sourceRestore: SourceRestoreOutcome | null = null
  const body = await serializeNoteBody(
    doc,
    {
      notePath,
      readFileBody,
      onSourceRestore: (outcome) => {
        sourceRestore = outcome
      }
    },
    converter
  )
  return { kind: 'serialized', body, sourceRestore }
}
