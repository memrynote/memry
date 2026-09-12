import { COLORS_DEFAULT } from '@blocknote/core'
import { BLOCK_COLOURS, type BlockColour } from '@memry/contracts/webview-bridge'

import type { BlockAction, BlockActionTarget } from './block-capabilities.ts'

/**
 * Colour, Duplicate, Move and Delete against ONE block (#2100), as a sheet the
 * guest draws in `#editor-chrome`.
 *
 * The formatting toolbar is native now, so this panel is the guest's own bottom
 * panel in the way find-in-note and the date sheet are: it takes the keyboard
 * away when it opens, pins to the bottom of the frame, and reports itself
 * through `onVisibilityChange` so the host hides the native toolbar and the
 * note footer while it is up. Every row is drawn from `target.caps`, which is
 * derived from the live schema — the panel holds no knowledge of block types.
 */

export interface BlockActionsPanelActions {
  /** Dispatch from the panel. The id is the panel's, not the caret's. */
  blockAction(blockId: string, action: BlockAction): void
}

export interface BlockActionsPanelController {
  /**
   * Show the panel for one already-addressed block.
   *
   * `onClose` fires once, when the panel stops addressing that block — Done, an
   * action that finished, the keyboard coming back, read-only. The block menu
   * hangs the highlight's lifetime off it.
   */
  openBlockActions(target: BlockActionTarget, onClose?: () => void): void
  closePanel(): void
  isOpen(): boolean
  setReadOnly(readOnly: boolean): void
  destroy(): void
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg(paths: readonly string[]): SVGSVGElement {
  const element = document.createElementNS(SVG_NS, 'svg')
  element.setAttribute('viewBox', '0 0 24 24')
  element.setAttribute('aria-hidden', 'true')
  for (const data of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', data)
    element.appendChild(path)
  }
  return element
}

function text(value: string, className?: string): HTMLSpanElement {
  const element = document.createElement('span')
  if (className) element.className = className
  element.textContent = value
  return element
}

function button(options: {
  label: string
  content: Node
  onPress: () => void
  className?: string
  pressed?: boolean
}): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `editor-panel-button${options.className ? ` ${options.className}` : ''}`
  element.setAttribute('aria-label', options.label)
  if (options.pressed !== undefined) element.setAttribute('aria-pressed', String(options.pressed))
  element.appendChild(options.content)
  element.addEventListener('click', options.onPress)
  return element
}

export function installBlockActionsPanel(
  host: HTMLElement,
  editorRoot: HTMLElement,
  actions: BlockActionsPanelActions,
  onVisibilityChange?: (open: boolean) => void
): BlockActionsPanelController {
  let target: BlockActionTarget | null = null
  let onClose: (() => void) | null = null
  let readOnly = false

  const colourRow = (
    title: string,
    active: BlockColour,
    swatch: (colour: BlockColour) => HTMLElement,
    onPick: (colour: BlockColour) => void
  ): HTMLElement => {
    const section = document.createElement('section')
    const row = document.createElement('div')
    row.className = 'editor-colour-row'
    for (const colour of BLOCK_COLOURS) {
      row.appendChild(
        button({
          label: `${title}: ${colour}`,
          content: swatch(colour),
          onPress: () => onPick(colour),
          className: 'editor-colour-swatch',
          pressed: active === colour
        })
      )
    }
    section.append(text(title, 'editor-picker-section-label'), row)
    return section
  }

  /**
   * A labelled full-width row. These are verbs against one block, and Delete
   * has to be able to look like the destructive one it is.
   */
  const actionRow = (options: {
    label: string
    paths: readonly string[]
    onPress: () => void
    destructive?: boolean
  }): HTMLButtonElement => {
    const glyph = text('', 'editor-picker-glyph')
    glyph.appendChild(svg(options.paths))
    const content = document.createDocumentFragment()
    content.append(glyph, text(options.label, 'editor-picker-label'))
    return button({
      label: options.label,
      content,
      onPress: options.onPress,
      className: `editor-block-action-row${options.destructive ? ' editor-block-action-destructive' : ''}`
    })
  }

  const render = (): void => {
    host.replaceChildren()
    host.hidden = target === null
    if (!target) return
    const current = target

    const shell = document.createElement('div')
    shell.className = 'editor-block-actions-shell'
    const panel = document.createElement('section')
    panel.className = 'editor-picker editor-block-actions'
    panel.setAttribute('aria-label', current.caps.label)

    const header = document.createElement('div')
    header.className = 'editor-picker-header'
    header.append(
      text(current.caps.label),
      button({
        label: 'Done',
        content: text('Done'),
        onPress: close,
        className: 'editor-block-actions-done'
      })
    )
    panel.appendChild(header)

    const scroll = document.createElement('div')
    scroll.className = 'editor-picker-scroll'

    if (current.caps.hasChildren) {
      // Duplicate, Move and Delete all carry the subtree, as they do on
      // desktop. On a phone that can double a note in one tap, so it is said
      // out loud rather than discovered.
      const note = text('Includes nested blocks', 'editor-picker-note')
      note.setAttribute('role', 'note')
      scroll.appendChild(note)
    }

    if (current.caps.colourText) {
      scroll.appendChild(
        colourRow(
          'Text colour',
          current.textColour,
          (colour) => {
            const chip = text('A', 'editor-colour-chip')
            chip.style.color = COLORS_DEFAULT[colour]?.text ?? 'inherit'
            return chip
          },
          (colour) => actions.blockAction(current.blockId, { kind: 'colour', slot: 'text', colour })
        )
      )
    }
    if (current.caps.colourBackground) {
      scroll.appendChild(
        colourRow(
          'Highlight',
          current.backgroundColour,
          (colour) => {
            const chip = text('A', 'editor-colour-chip')
            chip.style.background = COLORS_DEFAULT[colour]?.background ?? 'transparent'
            return chip
          },
          (colour) =>
            actions.blockAction(current.blockId, { kind: 'colour', slot: 'background', colour })
        )
      )
    }

    const rows = document.createElement('section')
    rows.className = 'editor-block-action-rows'
    rows.appendChild(
      actionRow({
        label: 'Duplicate',
        paths: ['M9 9h10v12H9z', 'M15 5H5v12'],
        onPress: () => actions.blockAction(current.blockId, { kind: 'duplicate' })
      })
    )
    if (current.caps.canMove) {
      rows.appendChild(
        actionRow({
          label: 'Move to another note…',
          paths: ['M4 6h6l2 2h8v11H4z', 'M10 13h6', 'm13.5 10.5 3 2.5-3 2.5'],
          onPress: () => actions.blockAction(current.blockId, { kind: 'move' })
        })
      )
    }
    rows.appendChild(
      actionRow({
        label: 'Delete',
        paths: ['M5 7h14', 'M9 7V5h6v2', 'M7 7l1 13h8l1-13', 'M10 11v6', 'M14 11v6'],
        onPress: () => actions.blockAction(current.blockId, { kind: 'delete' }),
        destructive: true
      })
    )
    scroll.appendChild(rows)

    panel.appendChild(scroll)
    shell.appendChild(panel)
    host.appendChild(shell)
  }

  function close(): void {
    if (target === null) return
    target = null
    render()
    onVisibilityChange?.(false)
    // After the render, so the notified party sees the DOM it is reacting to.
    // Cleared first: the callback belongs to the panel that has just gone.
    const notify = onClose
    onClose = null
    notify?.()
  }

  // The keyboard coming back means the reader tapped into the note, and a
  // sheet standing in the keyboard's place gives it back. `focusin` is the one
  // signal every keyboard-raising path shares, the same one the date sheet uses.
  const onFocusIn = (): void => close()
  editorRoot.addEventListener('focusin', onFocusIn)

  render()
  return {
    openBlockActions(next, nextOnClose) {
      if (readOnly) return
      const wasOpen = target !== null
      target = next
      onClose = nextOnClose ?? null
      render()
      if (wasOpen) return
      // The sheet takes the keyboard's space, so the keyboard has to go. Not
      // repeated on a re-render after a colour tap: that would blur an element
      // that is already blurred.
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
      onVisibilityChange?.(true)
    },
    closePanel: close,
    isOpen: () => target !== null,
    setReadOnly(next) {
      readOnly = next
      if (next) close()
    },
    destroy() {
      editorRoot.removeEventListener('focusin', onFocusIn)
      const wasOpen = target !== null
      target = null
      onClose = null
      host.replaceChildren()
      host.hidden = true
      if (wasOpen) onVisibilityChange?.(false)
    }
  }
}
