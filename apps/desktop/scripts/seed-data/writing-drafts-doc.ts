import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import {
  readWritingAlternativesFromYDoc,
  readWritingGhostsFromYDoc,
  readWritingOverflowFromYDoc,
  writeWritingAlternativesToYDoc,
  writeWritingGhostsToYDoc,
  writeWritingOverflowToYDoc,
  type WritingAlternative,
  type WritingAnchor,
  type WritingGhost,
  type WritingOverflowItem
} from '@memry/shared'
import { markdownToYFragment } from '../../src/main/sync/blocknote-converter'
import {
  WRITING_DRAFTS_ALTERNATIVES,
  WRITING_DRAFTS_GHOSTS,
  WRITING_DRAFTS_OVERFLOW,
  type TextLocation
} from './writing-drafts'

/** One paragraph run of the body, flattened: inline embeds count as one character, as in Yjs. */
interface TextRun {
  type: Y.XmlText
  plain: string
}

function plainTextOf(type: Y.XmlText): string {
  return (type.toDelta() as Array<{ insert: unknown }>)
    .map((op) => (typeof op.insert === 'string' ? op.insert : '\ufffc'))
    .join('')
}

function collectTextRuns(parent: Y.XmlFragment | Y.XmlElement, runs: TextRun[] = []): TextRun[] {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlText) runs.push({ type: child, plain: plainTextOf(child) })
    else if (child instanceof Y.XmlElement) collectTextRuns(child, runs)
  }
  return runs
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++
  return count
}

function locate(runs: TextRun[], location: TextLocation): { type: Y.XmlText; from: number } {
  const context = location.context ?? location.text
  const offsetInContext = context.indexOf(location.text)
  if (offsetInContext === -1) {
    throw new Error(`"${location.text}" is not inside its context "${context}"`)
  }
  const matches = runs.filter((run) => run.plain.includes(context))
  const total = runs.reduce((sum, run) => sum + countOccurrences(run.plain, context), 0)
  if (matches.length !== 1 || total !== 1) {
    throw new Error(`"${context}" must occur exactly once in the body, found ${total}`)
  }
  return { type: matches[0].type, from: matches[0].plain.indexOf(context) + offsetInContext }
}

/**
 * Anchors for one located range, shaped the way the editor takes them
 * (`anchorsForRange` in writing-tools-plugin.ts): the start binds to the
 * first character, the end to the last character with left association.
 */
function anchorsFor(
  runs: TextRun[],
  location: TextLocation
): { anchorStart: WritingAnchor; anchorEnd: WritingAnchor } {
  const { type, from } = locate(runs, location)
  const to = from + location.text.length
  const start = Y.createRelativePositionFromTypeIndex(type, from)
  const last = Y.createRelativePositionFromTypeIndex(type, to - 1)
  return {
    anchorStart: Y.relativePositionToJSON(start) as WritingAnchor,
    anchorEnd: { ...(Y.relativePositionToJSON(last) as WritingAnchor), assoc: -1 }
  }
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/**
 * The note's Y.Doc as the app's first open would build it from `content` (the
 * body `parseNote` reads out of the written file), plus the writing tools side
 * records anchored against it.
 */
export async function buildWritingDraftsDoc(
  noteId: string,
  content: string,
  notePath: string,
  now: number = Date.now()
): Promise<Y.Doc> {
  const doc = new Y.Doc({ guid: noteId })
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  if (!(await markdownToYFragment(content, fragment, notePath))) {
    throw new Error('markdownToYFragment could not seed the writing drafts note')
  }

  const runs = collectTextRuns(fragment)
  const minute = 60_000

  const alternatives: WritingAlternative[] = WRITING_DRAFTS_ALTERNATIVES.map((spec, index) => {
    const variants = spec.variants.map((variant, variantIndex) => ({
      id: newId('var'),
      text: variant.text,
      source: variant.source,
      createdAt: now - (index + 1) * 90 * minute + variantIndex * minute
    }))
    return {
      id: newId('alt'),
      ...anchorsFor(runs, spec.at),
      original: spec.original,
      variants,
      activeVariantId: spec.activeVariant === undefined ? null : variants[spec.activeVariant].id
    }
  })
  const ghosts: WritingGhost[] = WRITING_DRAFTS_GHOSTS.map((location) => ({
    id: newId('ghost'),
    ...anchorsFor(runs, location)
  }))
  const overflow: WritingOverflowItem[] = WRITING_DRAFTS_OVERFLOW.map((item, index) => ({
    id: newId('overflow'),
    ...item,
    createdAt: now - (WRITING_DRAFTS_OVERFLOW.length - index) * 45 * minute
  }))

  writeWritingAlternativesToYDoc(doc, alternatives)
  writeWritingGhostsToYDoc(doc, ghosts)
  writeWritingOverflowToYDoc(doc, overflow)
  return doc
}

// ----------------------------------------------------------------------------
// Verification
// ----------------------------------------------------------------------------

/** The body text an anchor pair resolves to, or null when it does not resolve to one run. */
export function resolveWritingAnchorText(
  doc: Y.Doc,
  anchorStart: WritingAnchor,
  anchorEnd: WritingAnchor
): string | null {
  const start = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(anchorStart),
    doc
  )
  const end = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(anchorEnd),
    doc
  )
  if (!start || !end || start.type !== end.type || !(start.type instanceof Y.XmlText)) return null
  if (end.index <= start.index) return null
  return plainTextOf(start.type).slice(start.index, end.index)
}

/**
 * Every problem with the side records on `doc`: a missing record, or an
 * anchor that does not resolve to the text the body shows for it. Empty when
 * the doc is what the seed meant to write.
 */
export function checkWritingDraftsDoc(doc: Y.Doc): string[] {
  const problems: string[] = []
  const alternatives = readWritingAlternativesFromYDoc(doc)
  const ghosts = readWritingGhostsFromYDoc(doc)
  const overflow = readWritingOverflowFromYDoc(doc)

  if (alternatives.length !== WRITING_DRAFTS_ALTERNATIVES.length) {
    problems.push(
      `expected ${WRITING_DRAFTS_ALTERNATIVES.length} alternatives, read ${alternatives.length}`
    )
  }
  alternatives.forEach((alternative, index) => {
    const spec = WRITING_DRAFTS_ALTERNATIVES[index]
    if (!spec) return
    const active = alternative.variants.find((v) => v.id === alternative.activeVariantId)
    const shown = active ? active.text : alternative.original
    if (shown !== spec.at.text) problems.push(`alternative ${index} shows "${shown}"`)
    const resolved = resolveWritingAnchorText(doc, alternative.anchorStart, alternative.anchorEnd)
    if (resolved !== shown) {
      problems.push(`alternative ${index} resolves to ${JSON.stringify(resolved)}, not "${shown}"`)
    }
  })

  if (ghosts.length !== WRITING_DRAFTS_GHOSTS.length) {
    problems.push(`expected ${WRITING_DRAFTS_GHOSTS.length} ghosts, read ${ghosts.length}`)
  }
  ghosts.forEach((ghost, index) => {
    const expected = WRITING_DRAFTS_GHOSTS[index]?.text
    const resolved = resolveWritingAnchorText(doc, ghost.anchorStart, ghost.anchorEnd)
    if (resolved !== expected) {
      problems.push(`ghost ${index} resolves to ${JSON.stringify(resolved)}, not "${expected}"`)
    }
  })

  const overflowTexts = overflow.map((item) => item.text)
  const expectedOverflow = WRITING_DRAFTS_OVERFLOW.map((item) => item.text)
  if (JSON.stringify(overflowTexts) !== JSON.stringify(expectedOverflow)) {
    problems.push(`overflow reads ${overflow.length} items that differ from the seed`)
  }
  return problems
}
