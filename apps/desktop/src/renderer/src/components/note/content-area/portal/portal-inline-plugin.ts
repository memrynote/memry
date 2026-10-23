/**
 * The portal window's own marks on the blocks it shows: a fold chevron in the
 * gutter of every block that has children, and an "N hidden" row under a block
 * whose children are not all shown (artboard 3).
 *
 * Both are widget decorations read off the window plugin's state, so they
 * follow every edit to the definition and take no part in the document. The
 * chevron reuses the bullet fold's markup and styles; the window hides that
 * view-only fold (`portal-block.css`) because folding here rewrites the
 * portal's definition instead.
 *
 * @module note/content-area/portal/portal-inline-plugin
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { BULLET_TOGGLE_CLASS } from '../bullet-collapse-plugin'
import { portalWindowKey, type PortalWindowState } from './portal-window-plugin'

export const PORTAL_HIDDEN_ROW_CLASS = 'portal-hidden-row'
export const PORTAL_FOLD_ATTR = 'data-portal-fold'

export interface PortalInlineHandlers {
  /** Text of the "N hidden" row. */
  hiddenLabel: (count: number) => string
  foldLabel: (expanded: boolean) => string
  editable: boolean
  openHidden: (blockId: string, anchorEl: HTMLElement) => void
  toggleFold: (blockId: string, expanded: boolean) => void
}

export const portalInlineKey = new PluginKey('portalInline')

const updateListeners = new WeakMap<EditorView, Set<() => void>>()

/** Call `listener` after every transaction of the window's editor. Returns the unsubscribe. */
export function onPortalWindowUpdate(view: EditorView, listener: () => void): () => void {
  let listeners = updateListeners.get(view)
  if (!listeners) {
    listeners = new Set()
    updateListeners.set(view, listeners)
  }
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'

const EYE_OFF_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>' +
  '<path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>' +
  '<line x1="2" x2="22" y1="2" y2="22"/></svg>'

function renderFold(
  block: { blockId: string },
  expanded: boolean,
  handlers: PortalInlineHandlers
): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = BULLET_TOGGLE_CLASS
  button.contentEditable = 'false'
  button.tabIndex = -1
  button.setAttribute(PORTAL_FOLD_ATTR, block.blockId)
  button.setAttribute('data-collapsed', String(!expanded))
  button.setAttribute('aria-expanded', String(expanded))
  button.setAttribute('aria-label', handlers.foldLabel(expanded))
  button.innerHTML = CHEVRON_SVG
  return button
}

function renderHiddenRow(
  block: { blockId: string },
  count: number,
  handlers: PortalInlineHandlers
): HTMLElement {
  const row = document.createElement('div')
  row.className = PORTAL_HIDDEN_ROW_CLASS
  row.contentEditable = 'false'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${PORTAL_HIDDEN_ROW_CLASS}-button`
  button.tabIndex = -1
  button.setAttribute('data-portal-hidden-for', block.blockId)
  button.innerHTML = EYE_OFF_SVG
  const label = document.createElement('span')
  label.textContent = handlers.hiddenLabel(count)
  button.append(label)
  row.append(button)
  return row
}

function buildDecorations(
  state: PortalWindowState,
  doc: PMNode,
  handlers: PortalInlineHandlers
): DecorationSet {
  const spec = state.spec
  if (spec.kind !== 'blocks') return DecorationSet.empty

  const decorations: Decoration[] = []
  for (const block of state.visible) {
    const node = doc.nodeAt(block.pos)
    const content = node?.firstChild
    if (!node || !content) continue

    const hiddenCount = state.hiddenChildren[block.blockId]?.length ?? 0
    const expanded = block.anchor !== null && spec.open[block.anchor] !== undefined
    if (hiddenCount > 0 || expanded) {
      decorations.push(
        // Between the content and the nested group, the order the bullet
        // fold's reveal-on-hover rule needs.
        Decoration.widget(
          block.pos + 1 + content.nodeSize,
          () => renderFold(block, expanded, handlers),
          {
            key: `portal-fold:${block.blockId}:${expanded}`,
            side: -1,
            ignoreSelection: true
          }
        )
      )
    }
    // A folded block says so with its chevron alone; the count is for blocks
    // the user opened and left partly hidden.
    if (hiddenCount > 0 && expanded) {
      decorations.push(
        // The last child of the block: below its shown children.
        Decoration.widget(
          block.pos + node.nodeSize - 1,
          () => renderHiddenRow(block, hiddenCount, handlers),
          {
            key: `portal-hidden:${block.blockId}:${hiddenCount}`,
            side: 1,
            ignoreSelection: true
          }
        )
      )
    }
  }
  return DecorationSet.create(doc, decorations)
}

/** `handlers.current` is null until the portal has rendered once; the plugin draws nothing then. */
export function createPortalInlinePlugin(handlers: {
  current: PortalInlineHandlers | null
}): Plugin {
  return new Plugin({
    key: portalInlineKey,
    view(view) {
      return {
        update() {
          for (const listener of updateListeners.get(view) ?? []) listener()
        }
      }
    },
    props: {
      decorations(state) {
        const window = portalWindowKey.getState(state)
        return window && handlers.current
          ? buildDecorations(window, state.doc, handlers.current)
          : null
      },
      handleDOMEvents: {
        // mousedown, not click: the widgets sit in a contenteditable, and the
        // default would move the caret first.
        mousedown(_view, event) {
          const target = event.target as HTMLElement | null
          const fold = target?.closest<HTMLElement>(`[${PORTAL_FOLD_ATTR}]`)
          if (fold) {
            event.preventDefault()
            if (handlers.current?.editable) {
              handlers.current.toggleFold(
                fold.getAttribute(PORTAL_FOLD_ATTR) ?? '',
                fold.getAttribute('aria-expanded') === 'true'
              )
            }
            return true
          }
          const hidden = target?.closest<HTMLElement>('[data-portal-hidden-for]')
          if (hidden) {
            event.preventDefault()
            handlers.current?.openHidden(
              hidden.getAttribute('data-portal-hidden-for') ?? '',
              hidden
            )
            return true
          }
          return false
        }
      }
    }
  })
}
