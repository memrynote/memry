/**
 * The count chip on a source block: how many notes show it through a portal.
 *
 * A ProseMirror plugin, not a React overlay, so the chip scrolls, wraps and
 * re-lays out with the block it belongs to. The plugin also tells the hook
 * which anchors the document carries (`anchors`), so usage is only looked up
 * for blocks that can be portaled. Counts come in by transaction meta and are
 * never stored in the document: the index is the truth.
 *
 * @module note/content-area/portal-flows/portal-usage-chip-plugin
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { extractAnchor } from '@memry/shared/portal-block'

export const PORTAL_USAGE_CHIP_CLASS = 'memry-portal-usage-chip'

const COUNTS_META = 'portalUsageCounts'

export interface PortalUsageChipState {
  /** Anchors the document's blocks end with, in document order. */
  anchors: readonly string[]
  /** Notes showing each anchor; an anchor absent here has no chip. */
  counts: ReadonlyMap<string, number>
  decorations: DecorationSet
}

export const PORTAL_USAGE_CHIP_KEY = new PluginKey<PortalUsageChipState>('portalUsageChip')

export interface PortalUsageChipOptions {
  /** aria-label for a chip, already translated. */
  label: (count: number) => string
  onOpen: (anchor: string, chip: HTMLElement) => void
}

/** Where each anchored block's text ends: the widget goes there, after the text. */
export function scanAnchoredBlocks(doc: ProseMirrorNode): { anchor: string; endPos: number }[] {
  const found: { anchor: string; endPos: number }[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const anchor = extractAnchor(node.textContent)
    if (anchor) found.push({ anchor, endPos: pos + 1 + node.content.size })
    return false
  })
  return found
}

function renderChip(anchor: string, count: number, options: PortalUsageChipOptions): HTMLElement {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = `${PORTAL_USAGE_CHIP_CLASS} ms-1.5 inline-flex cursor-pointer select-none items-center rounded-full bg-tint-light px-1.5 py-0.5 align-middle text-[11px] font-semibold leading-[14px] text-tint`
  // Inside a contenteditable: the attribute stops the browser editing the
  // button, and tabIndex keeps it out of the tab order so Tab still indents.
  chip.contentEditable = 'false'
  chip.tabIndex = -1
  chip.dataset.anchor = anchor
  chip.setAttribute('aria-label', options.label(count))
  chip.textContent = String(count)
  chip.addEventListener('mousedown', (event) => event.preventDefault())
  chip.addEventListener('click', () => options.onOpen(anchor, chip))
  return chip
}

function build(
  doc: ProseMirrorNode,
  counts: ReadonlyMap<string, number>,
  options: PortalUsageChipOptions
): DecorationSet {
  const decorations: Decoration[] = []
  for (const { anchor, endPos } of scanAnchoredBlocks(doc)) {
    const count = counts.get(anchor) ?? 0
    if (count <= 0) continue
    decorations.push(
      Decoration.widget(endPos, () => renderChip(anchor, count, options), {
        // Keyed by count so a changed number redraws and an unchanged one does
        // not, which would drop hover mid-click.
        key: `${PORTAL_USAGE_CHIP_CLASS}:${anchor}:${count}`,
        side: 1,
        ignoreSelection: true
      })
    )
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

export function createPortalUsageChipPlugin(options: PortalUsageChipOptions): Plugin {
  return new Plugin<PortalUsageChipState>({
    key: PORTAL_USAGE_CHIP_KEY,
    state: {
      init: (_config, state) => ({
        anchors: scanAnchoredBlocks(state.doc).map((hit) => hit.anchor),
        counts: new Map(),
        decorations: DecorationSet.empty
      }),
      apply: (tr, prev, _oldState, newState) => {
        const incoming = tr.getMeta(COUNTS_META) as ReadonlyMap<string, number> | undefined
        if (!incoming && !tr.docChanged) return prev
        const counts = incoming ?? prev.counts
        const anchors = tr.docChanged
          ? scanAnchoredBlocks(newState.doc).map((hit) => hit.anchor)
          : prev.anchors
        return { anchors, counts, decorations: build(newState.doc, counts, options) }
      }
    },
    props: {
      decorations: (state) => PORTAL_USAGE_CHIP_KEY.getState(state)?.decorations
    }
  })
}

/** The transaction meta that hands a view its counts. */
export function usageCountsMeta(counts: ReadonlyMap<string, number>): [string, unknown] {
  return [COUNTS_META, counts]
}
