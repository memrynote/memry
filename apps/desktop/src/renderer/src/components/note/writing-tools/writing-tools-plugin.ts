/**
 * ProseMirror glue for the writing tools: resolves the Y.RelativePosition
 * anchors of alternatives and ghosts to document ranges, keeps the transient
 * Lab ranges (style flags, trim cuts) mapped through edits, and paints all of
 * them as decorations. Nothing here changes the document; mirrors
 * `critic-markup-decorations.ts` / `date-mention-ghost-plugin.ts`.
 *
 * Anchored ranges are resolved from the Y.Doc only when the binding is known
 * to agree with the editor: on an explicit refresh (the records changed) and
 * on transactions y-prosemirror made from a Y change. Every other transaction
 * is local and has not reached the Y.Doc yet, so the ranges are mapped through
 * it instead, the way any decoration would be.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey
} from 'y-prosemirror'
import * as Y from 'yjs'
import type { WritingAnchor } from '@memry/shared'
import type { WritingTextBlock, WritingTextRange } from './writing-text'

export interface WritingRange extends WritingTextRange {
  id: string
}

export interface AnchoredRecord {
  id: string
  anchorStart: WritingAnchor
  anchorEnd: WritingAnchor
  /** Text to look for when the anchors no longer resolve (doc rebuilt or compacted). */
  fallbackTexts?: string[]
  /** The range must sit inside one textblock (alternatives swap it as one run of text). */
  singleTextblock?: boolean
  /**
   * Every text the range is expected to hold (an alternative's original and
   * variants). When the anchors resolve to something else, an occurrence of
   * one of these overlapping the resolved range wins: an undone swap leaves
   * the anchors on deleted variant characters next to the restored original.
   */
  knownTexts?: string[]
}

export interface AlternativeDisplay {
  /** A variant, not the original, is showing */
  active: boolean
  /** 1-based position of the shown text in original -> variants */
  position: number
  total: number
}

export interface WritingToolsPluginState {
  alternatives: WritingRange[]
  ghosts: WritingRange[]
  flags: WritingRange[]
  trims: WritingRange[]
  hoveredAlternativeId: string | null
  focusedFlagId: string | null
  focusedTrimId: string | null
}

export type WritingToolsMeta =
  | { type: 'refresh' }
  | { type: 'hover'; id: string | null }
  | { type: 'setFlags'; flags: WritingRange[] }
  | { type: 'focusFlag'; id: string | null }
  | { type: 'setTrims'; trims: WritingRange[]; focusedId: string | null }
  | { type: 'focusTrim'; id: string | null }

export interface WritingToolsPluginOptions {
  getAlternatives: () => AnchoredRecord[]
  getGhosts: () => AnchoredRecord[]
  describeAlternative: (id: string, shownText: string) => AlternativeDisplay | null
  formatHint: (position: number, total: number) => string
  /** After every state update the view applied, including the first. */
  onViewUpdate?: (view: EditorView) => void
}

export const writingToolsPluginKey = new PluginKey<WritingToolsPluginState>('writingTools')

interface BindingLike {
  doc: Y.Doc
  type: Y.XmlFragment
  mapping: Map<unknown, unknown>
}

function getBinding(state: EditorState): BindingLike | null {
  const binding = (ySyncPluginKey.getState(state) as { binding?: BindingLike } | undefined)?.binding
  return binding?.doc && binding.type && binding.mapping ? binding : null
}

/**
 * Anchors for [from, to). Both bind to characters inside the range: the start
 * to its first character (right association), the end to its last character
 * with left association, so it resolves to the position just after it.
 *
 * That makes deletions shrink the range instead of moving it: a deleted
 * first character resolves to where it was, which is where the next one now
 * starts, and a deleted last character resolves to where it was, which is
 * just after the new last one. Deleting the whole range collapses it to
 * nothing (from === to), and it stops resolving. Text typed right before or
 * after the range does not join it, same as an inline decoration.
 */
export function anchorsForRange(
  state: EditorState,
  from: number,
  to: number
): { anchorStart: WritingAnchor; anchorEnd: WritingAnchor } | null {
  const binding = getBinding(state)
  if (!binding || to <= from) return null
  try {
    const start = absolutePositionToRelativePosition(from, binding.type, binding.mapping as never)
    const last = absolutePositionToRelativePosition(to - 1, binding.type, binding.mapping as never)
    // Only a character id can carry the left association.
    if (!start.item || !last.item) return null
    const anchorEnd = Y.relativePositionToJSON(last) as WritingAnchor
    return {
      anchorStart: Y.relativePositionToJSON(start) as WritingAnchor,
      anchorEnd: { ...anchorEnd, assoc: -1 }
    }
  } catch {
    return null
  }
}

function resolveAnchoredRange(
  state: EditorState,
  binding: BindingLike | null,
  record: AnchoredRecord
): WritingTextRange | null {
  if (!binding) return null
  try {
    const resolve = (anchor: WritingAnchor): number | null =>
      relativePositionToAbsolutePosition(
        binding.doc,
        binding.type,
        Y.createRelativePositionFromJSON(anchor),
        binding.mapping as never
      )
    const from = resolve(record.anchorStart)
    const to = resolve(record.anchorEnd)
    if (from === null || to === null) return null
    if (from < 0 || to > state.doc.content.size || to <= from) return null
    if (record.singleTextblock && !isSingleTextblockRange(state.doc, from, to)) return null
    return { from, to }
  } catch {
    // A mapping that misses a type throws inside y-prosemirror; the range is
    // simply unresolvable until the next refresh.
    return null
  }
}

function isSingleTextblockRange(doc: ProseMirrorNode, from: number, to: number): boolean {
  const $from = doc.resolve(from)
  return $from.parent.isTextblock && $from.sameParent(doc.resolve(to))
}

/** Every textblock as one string, one character (or atom placeholder) per position. */
export function collectTextBlocks(doc: ProseMirrorNode): WritingTextBlock[] {
  const blocks: WritingTextBlock[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    blocks.push({
      from: pos + 1,
      text: node.textBetween(0, node.content.size, undefined, '\ufffc')
    })
    return false
  })
  return blocks
}

/** Selected text a single alternative can stand in for: one textblock, text only. */
export function isAlternativeRange(view: EditorView, from: number, to: number): boolean {
  if (to <= from) return false
  const $from = view.state.doc.resolve(from)
  const $to = view.state.doc.resolve(to)
  if (!$from.parent.isTextblock || !$from.sameParent($to)) return false
  const text = view.state.doc.textBetween(from, to, '\n', '\ufffc')
  return text.trim().length > 0 && !text.includes('\ufffc') && !text.includes('\n')
}

/**
 * A selection Stash can move without losing anything but formatting: some
 * text, and no non-text leaves (mentions, pills, images, embeds, breaks),
 * which the overflow list, being plain text, could not keep.
 */
export function isStashableRange(doc: ProseMirrorNode, from: number, to: number): boolean {
  if (to <= from || !doc.textBetween(from, to, '\n', '').trim()) return false
  let hasLeaf = false
  doc.nodesBetween(from, to, (node) => {
    if (hasLeaf) return false
    if (node.isLeaf && !node.isText) hasLeaf = true
    return !hasLeaf
  })
  return !hasLeaf
}

/**
 * The one place `text` occurs in the note, or null when it occurs nowhere or
 * more than once. A fallback that guessed between repeats could hand a body
 * swap someone else's words.
 */
export function findUniqueTextRange(
  blocks: WritingTextBlock[],
  text: string
): WritingTextRange | null {
  if (!text) return null
  let found: WritingTextRange | null = null
  for (const block of blocks) {
    let offset = block.text.indexOf(text)
    while (offset !== -1) {
      if (found) return null
      found = { from: block.from + offset, to: block.from + offset + text.length }
      offset = block.text.indexOf(text, offset + 1)
    }
  }
  return found
}

/**
 * `range`, or the single occurrence of a known text in the same textblock that
 * overlaps or touches it when `range` holds none of them. A range the user
 * edited by hand matches nothing nearby and is kept as it is.
 */
function snapToKnownText(
  doc: ProseMirrorNode,
  range: WritingTextRange,
  knownTexts: string[]
): WritingTextRange {
  const shown = doc.textBetween(range.from, range.to, '\n', '\ufffc')
  if (knownTexts.includes(shown)) return range
  const $from = doc.resolve(range.from)
  if (!$from.parent.isTextblock) return range
  const blockFrom = $from.start()
  const blockText = $from.parent.textBetween(0, $from.parent.content.size, undefined, '\ufffc')
  const candidates: WritingTextRange[] = []
  for (const text of new Set(knownTexts)) {
    if (!text) continue
    let offset = blockText.indexOf(text)
    while (offset !== -1) {
      const candidate = { from: blockFrom + offset, to: blockFrom + offset + text.length }
      if (candidate.from <= range.to && range.from <= candidate.to) candidates.push(candidate)
      offset = blockText.indexOf(text, offset + 1)
    }
  }
  return candidates.length === 1 ? candidates[0] : range
}

function resolveRecords(state: EditorState, records: AnchoredRecord[]): WritingRange[] {
  const binding = getBinding(state)
  let blocks: WritingTextBlock[] | null = null
  const ranges: WritingRange[] = []
  for (const record of records) {
    let range = resolveAnchoredRange(state, binding, record)
    if (range && record.knownTexts?.length)
      range = snapToKnownText(state.doc, range, record.knownTexts)
    if (!range && record.fallbackTexts?.length) {
      blocks ??= collectTextBlocks(state.doc)
      for (const text of record.fallbackTexts) {
        range = findUniqueTextRange(blocks, text)
        if (range) break
      }
    }
    if (range) ranges.push({ id: record.id, ...range })
  }
  return ranges.sort((a, b) => a.from - b.from)
}

function mapRanges(ranges: WritingRange[], tr: Transaction): WritingRange[] {
  if (!tr.docChanged || ranges.length === 0) return ranges
  return ranges.flatMap((range) => {
    const from = tr.mapping.map(range.from, 1)
    const to = tr.mapping.map(range.to, -1)
    return from < to ? [{ ...range, from, to }] : []
  })
}

function dotsWidget(id: string, active: boolean): HTMLElement {
  const span = document.createElement('span')
  span.className = active ? 'writing-alt-dots is-active' : 'writing-alt-dots'
  span.setAttribute('contenteditable', 'false')
  span.setAttribute('aria-hidden', 'true')
  span.dataset.writingAltId = id
  for (let index = 0; index < 3; index++) span.appendChild(document.createElement('span'))
  return span
}

function hintWidget(text: string): HTMLElement {
  const anchor = document.createElement('span')
  anchor.className = 'writing-alt-hint-anchor'
  anchor.setAttribute('contenteditable', 'false')
  anchor.setAttribute('aria-hidden', 'true')
  const hint = document.createElement('span')
  hint.className = 'writing-alt-hint'
  hint.textContent = text
  anchor.appendChild(hint)
  return anchor
}

export function createWritingToolsPlugin(options: WritingToolsPluginOptions): Plugin {
  const resolveAnchored = (state: EditorState) => ({
    alternatives: resolveRecords(state, options.getAlternatives()),
    ghosts: resolveRecords(state, options.getGhosts())
  })

  return new Plugin<WritingToolsPluginState>({
    key: writingToolsPluginKey,
    state: {
      init: (_config, state) => ({
        ...resolveAnchored(state),
        flags: [],
        trims: [],
        hoveredAlternativeId: null,
        focusedFlagId: null,
        focusedTrimId: null
      }),
      apply(tr, previous, _oldState, newState) {
        const meta = tr.getMeta(writingToolsPluginKey) as WritingToolsMeta | undefined
        const fromYjs =
          (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)
            ?.isChangeOrigin === true
        let next: WritingToolsPluginState =
          meta?.type === 'refresh' || fromYjs
            ? { ...previous, ...resolveAnchored(newState) }
            : {
                ...previous,
                alternatives: mapRanges(previous.alternatives, tr),
                ghosts: mapRanges(previous.ghosts, tr)
              }
        next = { ...next, flags: mapRanges(next.flags, tr), trims: mapRanges(next.trims, tr) }

        switch (meta?.type) {
          case 'hover':
            next = { ...next, hoveredAlternativeId: meta.id }
            break
          case 'setFlags':
            next = { ...next, flags: meta.flags, focusedFlagId: null }
            break
          case 'focusFlag':
            next = { ...next, focusedFlagId: meta.id }
            break
          case 'setTrims':
            next = { ...next, trims: meta.trims, focusedTrimId: meta.focusedId }
            break
          case 'focusTrim':
            next = { ...next, focusedTrimId: meta.id }
            break
        }
        return next
      }
    },
    view(view) {
      options.onViewUpdate?.(view)
      return { update: (updated) => options.onViewUpdate?.(updated) }
    },
    props: {
      decorations(state) {
        const pluginState = writingToolsPluginKey.getState(state)
        if (!pluginState) return null
        const decorations: Decoration[] = []

        for (const ghost of pluginState.ghosts) {
          decorations.push(
            Decoration.inline(ghost.from, ghost.to, {
              class: 'writing-ghost',
              'data-writing-ghost-id': ghost.id
            })
          )
        }

        for (const alternative of pluginState.alternatives) {
          const shownText = state.doc.textBetween(alternative.from, alternative.to, '\n', '\ufffc')
          const display = options.describeAlternative(alternative.id, shownText)
          if (!display) continue
          decorations.push(
            Decoration.inline(alternative.from, alternative.to, {
              class: 'writing-alt',
              'data-writing-alt-id': alternative.id
            }),
            Decoration.widget(alternative.to, () => dotsWidget(alternative.id, display.active), {
              side: 1,
              key: `writing-alt-dots:${alternative.id}:${display.active ? 1 : 0}`,
              ignoreSelection: true
            })
          )
          if (pluginState.hoveredAlternativeId === alternative.id) {
            const hint = options.formatHint(display.position, display.total)
            decorations.push(
              Decoration.widget(alternative.from, () => hintWidget(hint), {
                side: -1,
                key: `writing-alt-hint:${alternative.id}:${hint}`,
                ignoreSelection: true
              })
            )
          }
        }

        for (const flag of pluginState.flags) {
          decorations.push(
            Decoration.inline(flag.from, flag.to, {
              class:
                flag.id === pluginState.focusedFlagId
                  ? 'writing-lab-flag is-focused'
                  : 'writing-lab-flag',
              'data-writing-flag-id': flag.id
            })
          )
        }

        for (const trim of pluginState.trims) {
          decorations.push(
            Decoration.inline(trim.from, trim.to, {
              class:
                trim.id === pluginState.focusedTrimId ? 'writing-trim is-focused' : 'writing-trim',
              'data-writing-trim-id': trim.id
            })
          )
        }

        return DecorationSet.create(state.doc, decorations)
      }
    }
  })
}
