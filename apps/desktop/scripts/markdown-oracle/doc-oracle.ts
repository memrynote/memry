/**
 * Oracle ops of the Y.Doc half of the converter (stage 6 of #3522): seeding a
 * document from markdown, serializing it back (house style, source restore,
 * writing tools markers, CriticMarkup), the block view, `replaceDocBody` and
 * the fail-closed scans, all by running the Electron functions in place.
 *
 * Update bytes are never compared (client ids and struct order are free,
 * protocol 12.5.0), so a document is stated as its canonical fragment plus the
 * JSON of its side roots, and a writing tools anchor as the text run and index
 * it resolves to instead of the Yjs ids it is made of.
 */
import { setCalloutTypeDefinitions } from '@memry/editor-schema/blocks'
import * as Y from 'yjs'

import { classifyMarkdownContent } from '@memry/shared/markdown-class'

import { canonicalFragment } from '../../../../packages/contracts/scripts/fragment-canonical'
import {
  findUnrepresentableNodes,
  markdownToYFragment,
  prepareFragmentSeed,
  applyFragmentSeed,
  recordMarkdownSourceInYDoc,
  emptyDocumentBlocks,
  repairEmptyBlockIds,
  yDocToCanonicalMarkdown,
  yDocToMarkdown,
  yDocToMarkdownWithWritingRanges,
  yFragmentToBlocks,
  type SourceRestoreOutcome
} from '../../src/main/sync/blocknote-converter'
import { serializeNoteBody } from '../../src/main/sync/writing-markdown'
import { canonicalBlocks } from './bn-oracle'

const FRAGMENT = 'prosemirror'

interface CalloutTypeInput {
  name: string
  label: string
  color: string
  icon: string
}

export interface DocInput {
  markdown?: string
  notePath?: string
  calloutTypes?: CalloutTypeInput[]
  writing?: unknown
  /** Edits applied to the seeded document before it is read. */
  edits?: DocEdit[]
  /** A doc built from an update instead of from markdown. */
  updateHex?: string
  fragment?: string
  /** The file body `readFileBody` answers: a string, null (no file), or 'throw'. */
  fileBody?: string | null
  unlessChanged?: boolean
  baseMarkdown?: string
}

export type DocEdit =
  | { kind: 'insert-start'; run: number; text: string }
  | { kind: 'insert-end'; run: number; text: string }
  | { kind: 'clear-source' }
  | { kind: 'set-source'; source: string; htmlComments: boolean }
  | { kind: 'clear-critic' }
  | { kind: 'delete-fragment' }

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16))
}

function textRuns(parent: Y.XmlFragment | Y.XmlElement, runs: Y.XmlText[] = []): Y.XmlText[] {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) runs.push(child)
    else if (child instanceof Y.XmlElement) textRuns(child, runs)
  }
  return runs
}

function applyEdits(doc: Y.Doc, edits: DocEdit[] | undefined): void {
  for (const edit of edits ?? []) {
    switch (edit.kind) {
      case 'insert-start':
        textRuns(doc.getXmlFragment(FRAGMENT))[edit.run].insert(0, edit.text)
        break
      case 'insert-end': {
        const run = textRuns(doc.getXmlFragment(FRAGMENT))[edit.run]
        run.insert(run.length, edit.text)
        break
      }
      case 'clear-source':
        doc.getMap('markdownSource').delete('record')
        break
      case 'set-source':
        doc
          .getMap('markdownSource')
          .set('record', { source: edit.source, htmlComments: edit.htmlComments })
        break
      case 'clear-critic': {
        const array = doc.getArray('criticMarkupMarks')
        array.delete(0, array.length)
        break
      }
      case 'delete-fragment': {
        const fragment = doc.getXmlFragment(FRAGMENT)
        fragment.delete(0, fragment.length)
        break
      }
    }
  }
}

/** An anchor as the run and index it resolves to, or null when it does not resolve. */
function resolveAnchor(doc: Y.Doc, runs: Y.XmlText[], anchor: unknown): unknown {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- anchors on the doc are Y.relativePositionToJSON output
    const json = anchor as { assoc?: number }
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(json),
      doc
    )
    if (!abs || !(abs.type instanceof Y.XmlText)) return null
    const run = runs.indexOf(abs.type)
    return run < 0 ? null : { run, index: abs.index, assoc: json.assoc ?? 0 }
  } catch {
    return null
  }
}

function jsonOf(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

function rootsOf(doc: Y.Doc): Record<string, unknown> {
  const runs = textRuns(doc.getXmlFragment(FRAGMENT))
  const anchored = (name: string): unknown[] =>
    doc
      .getArray(name)
      .toArray()
      .map((record) => {
        const copy = jsonOf(record)
        if (copy && typeof copy === 'object') {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- jsonOf returns a plain JSON object here
          const target = copy as Record<string, unknown>
          for (const key of ['anchorStart', 'anchorEnd']) {
            if (key in target) target[key] = resolveAnchor(doc, runs, target[key])
          }
        }
        return copy
      })
  return {
    markdownSource: jsonOf(doc.getMap('markdownSource').get('record')),
    criticMarkupMarks: jsonOf(doc.getArray('criticMarkupMarks').toArray()),
    linkReferenceDefinitions: jsonOf(doc.getArray('linkReferenceDefinitions').toArray()),
    linkReferenceUsages: jsonOf(doc.getArray('linkReferenceUsages').toArray()),
    writingAlternatives: anchored('writingAlternatives'),
    writingGhosts: anchored('writingGhosts'),
    writingOverflow: jsonOf(doc.getArray('writingOverflow').toArray())
  }
}

/** The fragment as canonical text with the random `id` attributes removed. */
function fragmentText(doc: Y.Doc): string {
  return canonicalFragment(doc)
    .split('\n')
    .map((line) => line.replace(/ id="[^"]*"/, ''))
    .join('\n')
}

async function buildDoc(input: DocInput): Promise<Y.Doc | null> {
  const doc = new Y.Doc()
  if (input.updateHex !== undefined) {
    Y.applyUpdate(doc, fromHex(input.updateHex))
  } else {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the job's `writing` is a WritingFrontmatter written by the case list
    const writing = input.writing as Parameters<typeof markdownToYFragment>[3]
    const ok = await markdownToYFragment(
      input.markdown ?? '',
      doc.getXmlFragment(FRAGMENT),
      input.notePath,
      writing
    )
    if (!ok) return null
  }
  applyEdits(doc, input.edits)
  return doc
}

async function withTypes<T>(input: DocInput, run: () => Promise<T>): Promise<T> {
  setCalloutTypeDefinitions(input.calloutTypes ?? [])
  try {
    return await run()
  } finally {
    setCalloutTypeDefinitions([])
  }
}

function serializeOptions(input: DocInput, report: (o: SourceRestoreOutcome) => void) {
  return {
    notePath: input.notePath,
    onSourceRestore: report,
    ...(input.fileBody === undefined
      ? {}
      : {
          readFileBody: async (): Promise<string | null> => {
            if (input.fileBody === 'throw') throw new Error('unreadable')
            return input.fileBody ?? null
          }
        })
  }
}

/** Op `doc-seed`: the document markdown seeds. */
export function docSeed(input: DocInput): Promise<unknown> {
  return withTypes(input, async () => {
    const doc = await buildDoc(input)
    if (!doc) throw new Error('seed failed')
    return { seeded: true, fragment: fragmentText(doc), roots: rootsOf(doc) }
  })
}

/** Op `doc-serialize`: every way the document reads back as markdown. */
export function docSerialize(input: DocInput): Promise<unknown> {
  return withTypes(input, async () => {
    const doc = await buildDoc(input)
    if (!doc) throw new Error('seed failed')
    const fragment = input.fragment ?? FRAGMENT
    let outcome: SourceRestoreOutcome | null = null
    const markdown = await yDocToMarkdown(
      doc,
      fragment,
      serializeOptions(input, (o) => (outcome = o))
    )
    let noteOutcome: SourceRestoreOutcome | null = null
    const note = await serializeNoteBody(
      doc,
      serializeOptions(input, (o) => (noteOutcome = o)),
      { yDocToMarkdown, yDocToMarkdownWithWritingRanges }
    )
    return {
      seeded: true,
      markdown,
      outcome,
      canonical: await yDocToCanonicalMarkdown(doc, fragment),
      noteBody: note
        ? { markdown: note.markdown, writing: note.writing, outcome: noteOutcome }
        : null,
      unrepresentable: findUnrepresentableNodes(doc, fragment)
    }
  })
}

/** Op `doc-blocks`: the block view of the document. */
export function docBlocks(input: DocInput): Promise<unknown> {
  return withTypes(input, async () => {
    const doc = await buildDoc(input)
    if (!doc) throw new Error('seed failed')
    const blocks = await yFragmentToBlocks(doc.getXmlFragment(input.fragment ?? FRAGMENT))
    return { seeded: true, blocks: blocks ? canonicalBlocks(blocks) : null }
  })
}

/**
 * Op `doc-replace`: `replaceDocBody` (`crdt-feed.ts:55-95`) over the exported
 * converter functions, since the original is coupled to the CRDT provider.
 */
export function docReplace(input: DocInput): Promise<unknown> {
  return withTypes(input, async () => {
    const doc = await buildDoc({ ...input, markdown: input.baseMarkdown ?? '', writing: undefined })
    if (!doc) throw new Error('seed failed')
    const markdown = input.markdown ?? ''
    const fragment = doc.getXmlFragment(FRAGMENT)
    const before = fragment.toJSON()
    const outcome = await (async (): Promise<string> => {
      if (classifyMarkdownContent(markdown).sizeClass === 'large-file') return 'refused'
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the job's `writing` is a WritingFrontmatter written by the case list
      const writing = input.writing as Parameters<typeof prepareFragmentSeed>[2]
      const prepared = await prepareFragmentSeed(markdown, input.notePath, writing)
      if (!prepared) return 'failed'
      if (prepared.blocks.length === 0) prepared.blocks = emptyDocumentBlocks()
      // A string the fragment never holds stands for a body typed meanwhile.
      const unlessChangedFrom =
        input.unlessChanged === undefined ? undefined : input.unlessChanged ? before : '<stale/>'
      let replaced = false
      doc.transact(() => {
        if (unlessChangedFrom !== undefined && fragment.toJSON() !== unlessChangedFrom) return
        fragment.delete(0, fragment.length)
        applyFragmentSeed(prepared, fragment)
        replaced = true
      })
      if (!replaced) return 'changed'
      await recordMarkdownSourceInYDoc(doc, prepared.plainText, FRAGMENT)
      return 'replaced'
    })()
    return { seeded: true, outcome, fragment: fragmentText(doc), roots: rootsOf(doc) }
  })
}

/** Op `doc-repair-ids`: `repairEmptyBlockIds` on a doc built from an update. */
export function docRepairIds(input: DocInput): unknown {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, fromHex(input.updateHex ?? ''))
  const repaired = repairEmptyBlockIds(doc.getXmlFragment(input.fragment ?? FRAGMENT))
  return { repaired, fragment: fragmentText(doc) }
}

/**
 * Op `corpus-note`: what a vault body converts to, stated compactly. A field
 * the converter leaves equal to the input is omitted, so the file holds the
 * markdown of a note once.
 */
export async function docCorpusNote(input: DocInput): Promise<unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- docSerialize answers this shape (see above)
  const result = (await docSerialize(input)) as {
    seeded: boolean
    markdown?: string | null
    canonical?: string | null
    outcome?: string | null
  }
  const source = input.markdown ?? ''
  const differing = (value: string | null | undefined): string | null | undefined =>
    value === source ? undefined : value
  return {
    seeded: result.seeded,
    outcome: result.outcome ?? null,
    markdown: differing(result.markdown),
    canonical: differing(result.canonical)
  }
}
