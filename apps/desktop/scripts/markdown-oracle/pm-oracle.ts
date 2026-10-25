/**
 * Oracle ops for the ProseMirror layer of the converter (stage 2 of #3522): the
 * memry schema as BlockNote builds it, the content-expression automaton, and
 * y-prosemirror's fragment <-> document conversion.
 *
 * The schema is built exactly as `blocknote-converter.ts` builds `serverSchema`
 * (the converter keeps `getEditor` private, so the five lines are repeated).
 */
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { createMemrySchema } from '@memry/editor-schema'
import { memryCodeBlockOptions } from '@memry/editor-schema/code-block'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import * as Y from 'yjs'

import { canonicalFragment } from '../../../../packages/contracts/scripts/fragment-canonical'

// oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-type-assertion -- prosemirror-model is not a dependency of this app and its types are only reachable through BlockNote's untyped pmSchema; every value read here is dumped as JSON
type Pm = any

let cached: Pm

export function pmSchema(): Pm {
  if (!cached) {
    const schema = createMemrySchema({
      codeBlock: memryCodeBlockOptions,
      blocks: createServerBlockSpecs(),
      inline: createServerInlineSpecs()
    })
    cached = (ServerBlockNoteEditor.create({ schema }).editor as Pm).pmSchema
  }
  return cached
}

function attrDump(attrs: Record<string, Pm>): Pm[] {
  return Object.entries(attrs).map(([name, attr]) => {
    let value: Pm = { t: 'required' }
    if (attr.hasDefault) {
      const d = attr.default
      if (d === undefined) value = { t: 'undefined' }
      else if (d === null) value = { t: 'null' }
      else
        value = { t: typeof d === 'string' ? 'str' : typeof d === 'number' ? 'num' : 'bool', v: d }
    }
    return { name, default: value }
  })
}

/** The schema as data, in `schema.spec.nodes` order, with the facts derived from it. */
export function schemaDump(): unknown {
  const pm = pmSchema()
  const nodes: Pm[] = []
  pm.spec.nodes.forEach((name: string, spec: Pm) => {
    const t = pm.nodes[name]
    nodes.push({
      name,
      content: spec.content ?? '',
      marks: spec.marks ?? null,
      group: spec.group ?? '',
      inline: !!spec.inline,
      atom: !!spec.atom,
      code: !!spec.code,
      defining: !!spec.defining,
      isolating: !!spec.isolating,
      selectable: spec.selectable ?? null,
      linebreakReplacement: !!spec.linebreakReplacement,
      attrs: attrDump(t.attrs),
      derived: {
        isInline: t.isInline,
        isText: t.isText,
        isLeaf: t.isLeaf,
        isAtom: t.isAtom,
        inlineContent: t.inlineContent,
        allMarks: t.markSet === null,
        hasRequiredAttrs: t.hasRequiredAttrs(),
        whitespace: t.whitespace
      }
    })
  })
  const marks: Pm[] = []
  pm.spec.marks.forEach((name: string, spec: Pm) => {
    const t = pm.marks[name]
    marks.push({
      name,
      excludes: spec.excludes === undefined ? 'own' : spec.excludes === '_' ? 'all' : 'none',
      inclusive: spec.inclusive ?? null,
      attrs: attrDump(t.attrs),
      derived: {
        rank: t.rank,
        excludesNames: Object.keys(pm.marks).filter((other) => t.excludes(pm.marks[other]))
      }
    })
  })
  return { topNode: pm.topNodeType.name, nodes, marks }
}

function sample(name: string): Pm {
  const pm = pmSchema()
  return name === 'text' ? pm.text('x') : pm.nodes[name].createAndFill()
}

/** `Fragment.from(nodes)`, reached through an unchecked doc node. */
function fragmentOf(nodes: Pm[]): Pm {
  return pmSchema().topNodeType.create(null, nodes).content
}

function fragmentJson(fragment: Pm): unknown {
  return JSON.parse(JSON.stringify(fragment.content.map((n: Pm) => n.toJSON())))
}

/** Every type name a content automaton can take as an edge, walked over its states. */
function edgeNames(start: Pm): string[] {
  const names: string[] = []
  const seen = new Set<Pm>()
  const walk = (m: Pm): void => {
    if (seen.has(m)) return
    seen.add(m)
    for (const edge of m.next) {
      if (!names.includes(edge.type.name)) names.push(edge.type.name)
      walk(edge.next)
    }
  }
  walk(start)
  return names
}

const EXTRA_PROBES = ['paragraph', 'text', 'blockContainer', 'blockGroup', 'tableRow']

function probeSequence(nodeName: string, seq: string[]): Pm {
  const pm = pmSchema()
  const match = pm.nodes[nodeName].contentMatch
  const nodes = seq.map(sample)
  if (nodes.some((n) => n === null)) return null
  const fragment = fragmentOf(nodes)
  const matched = match.matchFragment(fragment)
  const fill = match.fillBefore(fragment, false)
  const fillEnd = match.fillBefore(fragment, true)
  return {
    seq,
    valid: matched !== null,
    validEnd: matched?.validEnd ?? false,
    defaultType: matched?.defaultType?.name ?? null,
    inlineContent: matched?.inlineContent ?? false,
    fill: fill ? fragmentJson(fill) : null,
    fillToEnd: fillEnd ? fragmentJson(fillEnd) : null
  }
}

/** `ContentMatch` facts for sequences of up to two children under one node type. */
export function contentMatchSweep(nodeName: string): unknown {
  const pm = pmSchema()
  const candidates = [...new Set([...edgeNames(pm.nodes[nodeName].contentMatch), ...EXTRA_PROBES])]
  const entries: unknown[] = []
  const add = (seq: string[]): void => {
    const entry = probeSequence(nodeName, seq)
    if (entry) entries.push(entry)
  }
  add([])
  for (const a of candidates) add([a])
  for (const a of candidates) {
    if (!probeSequence(nodeName, [a])?.valid) continue
    for (const b of candidates) add([a, b])
  }
  return entries
}

/** `ContentMatch.findWrapping` of every node type from the start state and after the first two edges. */
export function findWrappingSweep(nodeName: string): unknown {
  const pm = pmSchema()
  const match = pm.nodes[nodeName].contentMatch
  const afters: string[][] = [[], ...match.next.slice(0, 2).map((e: Pm) => [e.type.name])]
  const entries: unknown[] = []
  for (const after of afters) {
    const state = match.matchFragment(fragmentOf(after.map(sample)))
    for (const target of Object.keys(pm.nodes)) {
      const wrapping = state?.findWrapping(pm.nodes[target])
      entries.push({ after, target, wrapping: wrapping ? wrapping.map((t: Pm) => t.name) : null })
    }
  }
  return entries
}

function decode(updateHex: string, fragmentName: string): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Uint8Array.from(Buffer.from(updateHex, 'hex')))
  return { doc, fragment: doc.getXmlFragment(fragmentName) }
}

function countElements(node: Y.XmlFragment | Y.XmlElement): number {
  let total = 0
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlElement) total += 1 + countElements(child)
  }
  return total
}

function countNodes(node: Pm): number {
  if (node.isText) return 0
  let total = 1
  node.content.forEach((child: Pm) => {
    total += countNodes(child)
  })
  return total
}

function readDoc(updateHex: string, fragmentName: string): { pmDoc: Pm; removed: number } {
  const { fragment } = decode(updateHex, fragmentName)
  const before = countElements(fragment)
  const pmDoc = yXmlFragmentToProseMirrorRootNode(fragment, pmSchema())
  let kept = 0
  pmDoc.content.forEach((child: Pm) => {
    kept += countNodes(child)
  })
  return { pmDoc, removed: before - kept }
}

/** y-prosemirror's read of a stored update: the document node as JSON and what the repair removed. */
export function yxmlRead(updateHex: string, fragmentName: string): unknown {
  const { pmDoc, removed } = readDoc(updateHex, fragmentName)
  return { doc: JSON.parse(JSON.stringify(pmDoc.toJSON())), removed }
}

/** Read, then write the document into a fresh fragment; the result in canonical form. */
export function yxmlRoundtrip(updateHex: string, fragmentName: string): unknown {
  const { pmDoc } = readDoc(updateHex, fragmentName)
  const out = new Y.Doc()
  prosemirrorToYXmlFragment(pmDoc, out.getXmlFragment('prosemirror'))
  return { fragment: canonicalFragment(out) }
}
