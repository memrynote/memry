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
 *
 * Headings fold the same way (issue #3198), but what they hide is their
 * section, not nested children: every following sibling up to the next heading
 * of the same or a higher level, plus any blocks nested under the heading
 * itself. Toggleable headings are skipped — BlockNote gives them their own
 * persisted toggle, and two chevrons on one row would fight.
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

/** Class that hides a folded block's nested group or section siblings. */
export const COLLAPSED_CHILDREN_CLASS = 'memry-collapsed-children'

const TOGGLE_META = 'bulletCollapseToggle'

export interface BulletCollapseState {
  /** Ids of the `blockContainer`s whose children are hidden. */
  collapsed: ReadonlySet<string>
  decorations: DecorationSet
}

export interface NodeRange {
  from: number
  to: number
}

export interface CollapsibleBlock {
  id: string
  kind: 'bullet' | 'heading'
  /**
   * Where the chevron widget goes: right after the block's content node, which
   * is the `blockGroup`'s open position when the block has children.
   */
  togglePos: number
  /** Nodes hidden while folded, in document order and contiguous. */
  hidden: NodeRange[]
}

export interface BulletCollapseLabels {
  expand: string
  collapse: string
  expandSection: string
  collapseSection: string
}

function headingLevel(container: ProseMirrorNode): number | null {
  const content = container.firstChild
  if (content?.type.name !== 'heading') return null
  if (content.attrs.isToggleable === true) return null
  const level = Number(content.attrs.level)
  return Number.isFinite(level) ? level : null
}

/**
 * Every foldable block: bullet list items with nested blocks, and headings with
 * a non-empty section.
 *
 * A `blockContainer`'s content is `blockContent blockGroup?`, so "has children"
 * is exactly "its last child is a `blockGroup`" — a container with no nesting
 * has the content node as both first and last child, which the type check
 * below rejects.
 */
export function findCollapsibleBlocks(doc: ProseMirrorNode): CollapsibleBlock[] {
  const blocks: CollapsibleBlock[] = []
  doc.descendants((node, pos, parent, index) => {
    if (node.type.name !== 'blockContainer') return true
    const content = node.firstChild
    const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
    if (!content || !id) return true
    const togglePos = pos + 1 + content.nodeSize
    const group = node.lastChild
    const ownGroup: NodeRange[] =
      group?.type.name === 'blockGroup' ? [{ from: togglePos, to: togglePos + group.nodeSize }] : []

    if (content.type.name === 'bulletListItem') {
      if (ownGroup.length > 0) blocks.push({ id, kind: 'bullet', togglePos, hidden: ownGroup })
      return true
    }

    const level = headingLevel(node)
    if (level === null || !parent) return true
    const hidden = [...ownGroup]
    let siblingPos = pos + node.nodeSize
    for (let i = index + 1; i < parent.childCount; i++) {
      const sibling = parent.child(i)
      // Any heading ends the section at its level, toggleable or not.
      const siblingContent = sibling.firstChild
      if (siblingContent?.type.name === 'heading' && Number(siblingContent.attrs.level) <= level) {
        break
      }
      hidden.push({ from: siblingPos, to: siblingPos + sibling.nodeSize })
      siblingPos += sibling.nodeSize
    }
    if (hidden.length > 0) blocks.push({ id, kind: 'heading', togglePos, hidden })
    return true
  })
  return blocks
}

const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'

function renderToggle(
  block: CollapsibleBlock,
  isCollapsed: boolean,
  labels: BulletCollapseLabels
): HTMLElement {
  const blockId = block.id
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
  const heading = block.kind === 'heading'
  button.setAttribute(
    'aria-label',
    isCollapsed
      ? heading
        ? labels.expandSection
        : labels.expand
      : heading
        ? labels.collapseSection
        : labels.collapse
  )
  button.innerHTML = CHEVRON_SVG
  return button
}

function buildDecorations(
  doc: ProseMirrorNode,
  collapsed: ReadonlySet<string>,
  labels: BulletCollapseLabels
): DecorationSet {
  const decorations: Decoration[] = []
  for (const block of findCollapsibleBlocks(doc)) {
    const isCollapsed = collapsed.has(block.id)
    decorations.push(
      // Anchored at the `blockGroup`'s open position with `side: -1`, so the
      // button lands between `.bn-block-content` and `.bn-block-group` — the
      // sibling order the `.bn-block-content:hover ~` reveal rule needs. Its
      // own placement is absolute, so DOM order costs no layout.
      Decoration.widget(block.togglePos, () => renderToggle(block, isCollapsed, labels), {
        // Without a key ProseMirror rebuilds the button on every redraw, which
        // would drop the hover state mid-click.
        key: `${BULLET_TOGGLE_CLASS}:${block.id}:${isCollapsed}`,
        side: -1,
        ignoreSelection: true
      })
    )
    if (isCollapsed) {
      for (const range of block.hidden) {
        decorations.push(Decoration.node(range.from, range.to, { class: COLLAPSED_CHILDREN_CLASS }))
      }
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
  block: CollapsibleBlock
): void {
  const { from, to } = state.selection
  const hiddenFrom = block.hidden[0].from
  const hiddenTo = block.hidden[block.hidden.length - 1].to
  if (to <= hiddenFrom || from >= hiddenTo) return
  // `togglePos - 1` is inside the block's own content node, at its end.
  tr.setSelection(TextSelection.near(tr.doc.resolve(block.togglePos - 1), -1))
}

/** Flips one block's fold. Exported for tests and for any future shortcut. */
export function toggleBulletCollapse(view: EditorView, blockId: string): boolean {
  const pluginState = BULLET_COLLAPSE_PLUGIN_KEY.getState(view.state)
  if (!pluginState) return false

  const tr = view.state.tr.setMeta(TOGGLE_META, blockId)
  if (!pluginState.collapsed.has(blockId)) {
    const block = findCollapsibleBlocks(view.state.doc).find((b) => b.id === blockId)
    if (block) moveSelectionOutOfSubtree(view.state, tr, block)
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
        const toggleMeta: unknown = tr.getMeta(TOGGLE_META)
        const toggledId = typeof toggleMeta === 'string' ? toggleMeta : undefined
        if (toggledId !== undefined) {
          const collapsed = new Set(value.collapsed)
          if (!collapsed.delete(toggledId)) collapsed.add(toggledId)
          return { collapsed, decorations: buildDecorations(newState.doc, collapsed, labels) }
        }

        if (!tr.docChanged) return value

        // A block that lost its children or section (or was deleted) has no
        // chevron left to un-fold it with, so its id must not linger — content
        // added under it later would otherwise come back mysteriously folded.
        const live = new Set(findCollapsibleBlocks(newState.doc).map((block) => block.id))
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
          const target = event.target instanceof Element ? event.target : null
          const button = target?.closest(`.${BULLET_TOGGLE_CLASS}`)
          const blockId = button?.getAttribute('data-block-id')
          if (!blockId) return false
          event.preventDefault()
          return toggleBulletCollapse(view, blockId)
        }
      }
    }
  })
}
