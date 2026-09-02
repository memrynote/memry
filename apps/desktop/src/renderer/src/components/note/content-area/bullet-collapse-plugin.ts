/**
 * Folding a bullet list item's children from a chevron in its gutter.
 *
 * The editor already has a fold — `toggleListItem`, BlockNote's own toggle
 * block — but that is a block TYPE: turning an outline into something foldable
 * means converting every parent line to a different block. Outliners fold the
 * bullets themselves, which is what this adds (user feedback, "toggle section
 * UI"): every `bulletListItem` that has nested blocks gets a chevron beside its
 * marker, and clicking it hides that block's `blockGroup`.
 *
 * The fold is VIEW state, deliberately, and the opposite call from the one
 * `toggle-list-item-block.ts` makes for the toggle block. A toggle carries its
 * fold in a block prop because its `open` prop is part of its serialization
 * contract; a bullet's is not. Notes are stored as markdown, and markdown has
 * no syntax for "this bullet is folded" — a prop would be dropped on the next
 * parse, so persisting it would mean inventing vault syntax for a display
 * preference. Nothing here dispatches a document change: the collapsed set
 * lives in plugin state, the transaction that flips it is selection-only, and
 * neither sync nor the vault file ever sees it.
 */

import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

export const BULLET_COLLAPSE_PLUGIN_KEY = new PluginKey<BulletCollapseState>('bulletCollapse')

/** Class the stylesheet keys the chevron's placement and reveal-on-hover off. */
export const BULLET_TOGGLE_CLASS = 'memry-bullet-toggle'

/**
 * Width, in px, of the gutter the chevron claims inline-start of the block.
 * `base.css` places the button in it and `ContentArea` moves BlockNote's drag
 * handle out of it by the same amount, so the two never share a pixel.
 */
export const BULLET_FOLD_GUTTER = 20

/** Class that hides a folded bullet's `blockGroup`. */
export const COLLAPSED_CHILDREN_CLASS = 'memry-collapsed-children'

const TOGGLE_META = 'bulletCollapseToggle'

export interface BulletCollapseState {
  /** Ids of the `blockContainer`s whose children are hidden. */
  collapsed: ReadonlySet<string>
  decorations: DecorationSet
}

export interface CollapsibleBullet {
  id: string
  /** Position of the `blockGroup` holding this bullet's nested blocks. */
  groupPos: number
  groupSize: number
}

export interface BulletCollapseLabels {
  expand: string
  collapse: string
}

/**
 * Every bullet list item in the document that has nested blocks.
 *
 * A `blockContainer`'s content is `blockContent blockGroup?`, so "has children"
 * is exactly "its last child is a `blockGroup`" — a container with no nesting
 * has the content node as both first and last child, which the type check
 * below rejects.
 */
export function findCollapsibleBullets(doc: ProseMirrorNode): CollapsibleBullet[] {
  const bullets: CollapsibleBullet[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const content = node.firstChild
    const group = node.lastChild
    if (!content || !group || group.type.name !== 'blockGroup') return true
    if (content.type.name !== 'bulletListItem') return true
    const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
    if (!id) return true
    bullets.push({ id, groupPos: pos + 1 + content.nodeSize, groupSize: group.nodeSize })
    return true
  })
  return bullets
}

const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'

function renderToggle(
  blockId: string,
  isCollapsed: boolean,
  labels: BulletCollapseLabels
): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = BULLET_TOGGLE_CLASS
  // Both halves matter inside a contenteditable: the attribute keeps the
  // browser from editing the button, and `tabIndex` keeps it out of the tab
  // order so Tab still indents the block it sits on.
  button.contentEditable = 'false'
  button.tabIndex = -1
  button.setAttribute('data-block-id', blockId)
  button.setAttribute('data-collapsed', String(isCollapsed))
  button.setAttribute('aria-expanded', String(!isCollapsed))
  button.setAttribute('aria-label', isCollapsed ? labels.expand : labels.collapse)
  button.innerHTML = CHEVRON_SVG
  return button
}

function buildDecorations(
  doc: ProseMirrorNode,
  collapsed: ReadonlySet<string>,
  labels: BulletCollapseLabels
): DecorationSet {
  const decorations: Decoration[] = []
  for (const bullet of findCollapsibleBullets(doc)) {
    const isCollapsed = collapsed.has(bullet.id)
    decorations.push(
      // Anchored at the `blockGroup`'s open position with `side: -1`, so the
      // button lands between `.bn-block-content` and `.bn-block-group` — the
      // sibling order the `.bn-block-content:hover ~` reveal rule needs. Its
      // own placement is absolute, so DOM order costs no layout.
      Decoration.widget(bullet.groupPos, () => renderToggle(bullet.id, isCollapsed, labels), {
        // Without a key ProseMirror rebuilds the button on every redraw, which
        // would drop the hover state mid-click.
        key: `${BULLET_TOGGLE_CLASS}:${bullet.id}:${isCollapsed}`,
        side: -1,
        ignoreSelection: true
      })
    )
    if (isCollapsed) {
      decorations.push(
        Decoration.node(bullet.groupPos, bullet.groupPos + bullet.groupSize, {
          class: COLLAPSED_CHILDREN_CLASS
        })
      )
    }
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

/**
 * Pull the caret out of a subtree that is about to be hidden.
 *
 * `display: none` does not move the selection, so folding around the caret
 * would leave typing going into content nobody can see.
 */
function moveSelectionOutOfSubtree(
  state: EditorState,
  tr: Transaction,
  bullet: CollapsibleBullet
): void {
  const { from, to } = state.selection
  const groupEnd = bullet.groupPos + bullet.groupSize
  if (to <= bullet.groupPos || from >= groupEnd) return
  // `groupPos - 1` is inside the bullet's own content node, at its end.
  tr.setSelection(TextSelection.near(tr.doc.resolve(bullet.groupPos - 1), -1))
}

/** Flips one bullet's fold. Exported for tests and for any future shortcut. */
export function toggleBulletCollapse(view: EditorView, blockId: string): boolean {
  const pluginState = BULLET_COLLAPSE_PLUGIN_KEY.getState(view.state)
  if (!pluginState) return false

  const tr = view.state.tr.setMeta(TOGGLE_META, blockId)
  if (!pluginState.collapsed.has(blockId)) {
    const bullet = findCollapsibleBullets(view.state.doc).find((b) => b.id === blockId)
    if (bullet) moveSelectionOutOfSubtree(view.state, tr, bullet)
  }
  view.dispatch(tr)
  return true
}

export function createBulletCollapsePlugin(labels: BulletCollapseLabels): Plugin {
  return new Plugin<BulletCollapseState>({
    key: BULLET_COLLAPSE_PLUGIN_KEY,

    state: {
      init: (_config, state) => {
        const collapsed = new Set<string>()
        return { collapsed, decorations: buildDecorations(state.doc, collapsed, labels) }
      },

      apply(tr, value, _oldState, newState) {
        const toggledId = tr.getMeta(TOGGLE_META) as string | undefined
        if (toggledId !== undefined) {
          const collapsed = new Set(value.collapsed)
          if (!collapsed.delete(toggledId)) collapsed.add(toggledId)
          return { collapsed, decorations: buildDecorations(newState.doc, collapsed, labels) }
        }

        if (!tr.docChanged) return value

        // A bullet that lost its children (or was deleted) has no chevron left
        // to un-fold it with, so its id must not linger — re-nesting under it
        // later would otherwise come back mysteriously folded.
        const bullets = findCollapsibleBullets(newState.doc)
        const live = new Set(bullets.map((bullet) => bullet.id))
        const collapsed = new Set([...value.collapsed].filter((id) => live.has(id)))
        return { collapsed, decorations: buildDecorations(newState.doc, collapsed, labels) }
      }
    },

    props: {
      decorations(state) {
        return BULLET_COLLAPSE_PLUGIN_KEY.getState(state)?.decorations ?? null
      },

      handleDOMEvents: {
        // mousedown, not click: the button is inside a contenteditable, and
        // letting the default run first would put the caret in the block and
        // scroll it into view before the fold is applied.
        mousedown(view, event) {
          const target = event.target as HTMLElement | null
          const button = target?.closest?.(`.${BULLET_TOGGLE_CLASS}`)
          const blockId = button?.getAttribute('data-block-id')
          if (!blockId) return false
          event.preventDefault()
          return toggleBulletCollapse(view, blockId)
        }
      }
    }
  })
}
