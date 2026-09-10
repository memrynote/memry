import { COLORS_DEFAULT } from '@blocknote/core'

import type { TableStructureOp } from './tables.ts'

export type InlineStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code'

/**
 * The alignments desktop's `TextAlignButton` offers (#2102).
 *
 * `justify` is in BlockNote's prop but on neither toolbar, so it is not here
 * either — the value is still read back untouched on a block desktop justified.
 */
export type TextAlignment = 'left' | 'center' | 'right'

export const TEXT_ALIGNMENTS = [
  'left',
  'center',
  'right'
] as const satisfies readonly TextAlignment[]

const ALIGNMENT_LABELS: Readonly<Record<TextAlignment, string>> = {
  left: 'Align left',
  center: 'Align centre',
  right: 'Align right'
}

/** Bar lengths, not a character: no font has a left/right-aligned `≡`. */
const ALIGNMENT_PATHS: Readonly<Record<TextAlignment, readonly string[]>> = {
  left: ['M4 7h16', 'M4 12h10', 'M4 17h14'],
  center: ['M4 7h16', 'M7 12h10', 'M5 17h14'],
  right: ['M4 7h16', 'M10 12h10', 'M6 17h14']
}

/**
 * The palette desktop paints with, verbatim.
 *
 * These are the ten entries `@blocknote/react`'s `ColorPicker` lists, and the
 * values land in the same `textColor` / `backgroundColor` styles the desktop
 * `ColorStyleButton` writes — so a run coloured on the phone is the same
 * string desktop reads back, and the markdown colour marker is unchanged.
 */
export const BLOCK_COLOURS = [
  'default',
  'gray',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink'
] as const

export type BlockColour = (typeof BLOCK_COLOURS)[number]

/** What the style panel can ask for (#2102). */
export type StyleAction =
  | { kind: 'align'; alignment: TextAlignment }
  | { kind: 'text-colour'; colour: BlockColour }
  | { kind: 'background-colour'; colour: BlockColour }
  | { kind: 'nest' }
  | { kind: 'unnest' }

export type ConvertibleBlock =
  | { kind: 'paragraph' }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: 'bulletListItem' }
  | { kind: 'numberedListItem' }
  | { kind: 'checkListItem' }
  | { kind: 'toggleListItem' }
  | { kind: 'quote' }
  | { kind: 'codeBlock' }
  | { kind: 'callout' }

export type InsertBlockAction =
  | { kind: 'convertible'; block: ConvertibleBlock }
  | { kind: 'divider' }
  | { kind: 'table' }
  | { kind: 'attachment'; blockType: 'image' | 'file' }
  | { kind: 'wikiLink' }

/**
 * What the table panel can ask for (#2101).
 *
 * `inline-image` and `inline-checkbox` sit here rather than in the block
 * picker because a table cell is inline-only: the `image` block cannot go in
 * one, and the two inline specs that can have had no entry point on mobile.
 */
export type TableAction =
  | { kind: 'structure'; op: TableStructureOp }
  | { kind: 'inline-image' }
  | { kind: 'inline-checkbox' }
  | { kind: 'delete-table' }

interface PickerVisual {
  label: string
  glyph: string
  glyphStyle?: 'serif' | 'mono'
  /** Drawn instead of `glyph` when the mark is a shape no character carries. */
  glyphNode?: Node
}

interface PickerItem extends PickerVisual {
  action: InsertBlockAction
}

interface PickerGroup {
  label: string
  items: readonly PickerItem[]
}

interface TablePickerItem extends PickerVisual {
  action: TableAction
  /** Locked out when the table carries a merged cell the phone cannot re-index. */
  structural?: boolean
}

interface TablePickerGroup {
  label: string
  items: readonly TablePickerItem[]
}

export const BLOCK_PICKER_GROUPS = [
  {
    label: 'Basic blocks',
    items: [
      {
        label: 'Text',
        glyph: 'T',
        glyphStyle: 'serif',
        action: { kind: 'convertible', block: { kind: 'paragraph' } }
      },
      ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
        label: `Heading ${level}`,
        glyph: `H${level}`,
        glyphStyle: 'serif' as const,
        action: { kind: 'convertible' as const, block: { kind: 'heading' as const, level } }
      })),
      {
        label: 'Bulleted list',
        glyph: '•',
        action: { kind: 'convertible', block: { kind: 'bulletListItem' } }
      },
      {
        label: 'Numbered list',
        glyph: '1.',
        action: { kind: 'convertible', block: { kind: 'numberedListItem' } }
      },
      {
        label: 'To-do list',
        glyph: '✓',
        action: { kind: 'convertible', block: { kind: 'checkListItem' } }
      },
      {
        label: 'Toggle list',
        glyph: '▸',
        action: { kind: 'convertible', block: { kind: 'toggleListItem' } }
      },
      {
        label: 'Quote',
        glyph: '“',
        glyphStyle: 'serif',
        action: { kind: 'convertible', block: { kind: 'quote' } }
      },
      {
        label: 'Code',
        glyph: '</>',
        glyphStyle: 'mono',
        action: { kind: 'convertible', block: { kind: 'codeBlock' } }
      },
      { label: 'Callout', glyph: '!', action: { kind: 'convertible', block: { kind: 'callout' } } },
      { label: 'Divider', glyph: '—', action: { kind: 'divider' } }
    ]
  },
  {
    label: 'Media',
    items: [
      { label: 'Image', glyph: '▧', action: { kind: 'attachment', blockType: 'image' } },
      { label: 'File', glyph: '⌑', action: { kind: 'attachment', blockType: 'file' } }
    ]
  },
  {
    label: 'Advanced',
    items: [
      { label: 'Table', glyph: '▦', action: { kind: 'table' } },
      { label: 'Link to note', glyph: '[[', glyphStyle: 'mono', action: { kind: 'wikiLink' } }
    ]
  }
] as const satisfies readonly PickerGroup[]

export const TURN_INTO_ITEMS: readonly PickerItem[] = BLOCK_PICKER_GROUPS[0].items.filter(
  (item) => item.action.kind === 'convertible'
)

/**
 * The table panel, which is mobile's whole answer to desktop's border nubs.
 *
 * Every row is an ordinary picker card, so each one is a 64 px target rather
 * than a hairline on a cell border, and the operation applies to the cell the
 * caret is already in — there is nothing to aim at.
 */
export const TABLE_PICKER_GROUPS: readonly TablePickerGroup[] = [
  {
    label: 'Row',
    items: [
      {
        label: 'Insert above',
        glyph: '⤒',
        structural: true,
        action: { kind: 'structure', op: { kind: 'insert-row', side: 'above' } }
      },
      {
        label: 'Insert below',
        glyph: '⤓',
        structural: true,
        action: { kind: 'structure', op: { kind: 'insert-row', side: 'below' } }
      },
      {
        label: 'Move up',
        glyph: '↑',
        structural: true,
        action: { kind: 'structure', op: { kind: 'move-row', direction: 'up' } }
      },
      {
        label: 'Move down',
        glyph: '↓',
        structural: true,
        action: { kind: 'structure', op: { kind: 'move-row', direction: 'down' } }
      },
      {
        label: 'Delete row',
        glyph: '⊖',
        structural: true,
        action: { kind: 'structure', op: { kind: 'delete-row' } }
      }
    ]
  },
  {
    label: 'Column',
    items: [
      {
        label: 'Insert before',
        glyph: '⇤',
        structural: true,
        action: { kind: 'structure', op: { kind: 'insert-column', side: 'before' } }
      },
      {
        label: 'Insert after',
        glyph: '⇥',
        structural: true,
        action: { kind: 'structure', op: { kind: 'insert-column', side: 'after' } }
      },
      {
        label: 'Move start',
        glyph: '↞',
        structural: true,
        action: { kind: 'structure', op: { kind: 'move-column', direction: 'start' } }
      },
      {
        label: 'Move end',
        glyph: '↠',
        structural: true,
        action: { kind: 'structure', op: { kind: 'move-column', direction: 'end' } }
      },
      {
        label: 'Delete column',
        glyph: '⊖',
        structural: true,
        action: { kind: 'structure', op: { kind: 'delete-column' } }
      }
    ]
  },
  {
    label: 'Cell',
    items: [
      { label: 'Image', glyph: '▧', action: { kind: 'inline-image' } },
      { label: 'Checkbox', glyph: '☐', action: { kind: 'inline-checkbox' } }
    ]
  },
  {
    label: 'Table',
    items: [{ label: 'Delete table', glyph: '✕', action: { kind: 'delete-table' } }]
  }
]

/** Present only while the caret is inside a table cell. */
export interface TableSelectionState {
  /** The table holds a merged cell, so row and column indices no longer line up. */
  structureLocked: boolean
}

export interface EditorToolbarSelection {
  blockLabel: string
  activeStyles: Readonly<Record<InlineStyle, boolean>>
  table: TableSelectionState | null
  /**
   * `null` on a block that has no `textAlignment` prop — a table, an image.
   * A `justify` written on desktop arrives here verbatim and simply checks
   * none of the three cards, rather than being rewritten to `left`.
   */
  alignment: string | null
  textColour: BlockColour
  backgroundColour: BlockColour
  canNest: boolean
  canUnnest: boolean
}

export interface EditorToolbarActions {
  insert(action: InsertBlockAction): void
  tableAction(action: TableAction): void
  styleAction(action: StyleAction): void
  turnInto(block: ConvertibleBlock): void
  toggleStyle(style: InlineStyle): void
  toggleBulletedList(): void
  createLink(url: string): void
  focusEditor(): void
  insertWikiLink(): void
  insertImage(): void
  undo(): void
  redo(): void
  dismissKeyboard(): void
}

export interface EditorToolbarController {
  update(selection: EditorToolbarSelection): void
  setReadOnly(readOnly: boolean): void
  setKeyboardVisible(visible: boolean): void
  setSuppressed(suppressed: boolean): void
  isPanelOpen(): boolean
  closePanel(): void
  destroy(): void
}

type ToolbarView =
  | { kind: 'main' }
  | { kind: 'formatting' }
  | { kind: 'blocks' }
  | { kind: 'turn-into' }
  | { kind: 'table' }
  | { kind: 'style' }
  | { kind: 'link-prompt' }

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

function readViewportBottomInset(): number {
  const inset = Number.parseFloat(
    document.documentElement.style.getPropertyValue('--memry-viewport-bottom-inset')
  )
  return Number.isFinite(inset) ? Math.max(0, inset) : 0
}

/**
 * The keyboard height the host reported, in CSS px.
 *
 * Preferred over the visual-viewport inset for the block picker: the WebView is
 * inside a KeyboardAvoidingView, so the inset only covers the overlap between
 * the keyboard and the (already shrunk) frame -- a few dozen px rather than the
 * whole keyboard. That undercount is what made the picker open as a sliver.
 */
function readHostKeyboardHeight(): number {
  const height = Number.parseFloat(
    document.documentElement.style.getPropertyValue('--memry-keyboard-height')
  )
  return Number.isFinite(height) ? Math.max(0, height) : 0
}

function actionButton(options: {
  label: string
  content: Node
  onPress: () => void
  className?: string
  pressed?: boolean
  /** Picker cards must leave pointer movement alone so a card can start a scroll. */
  preserveEditorSelection?: boolean
}): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `editor-toolbar-button${options.className ? ` ${options.className}` : ''}`
  element.setAttribute('aria-label', options.label)
  if (options.pressed !== undefined) element.setAttribute('aria-pressed', String(options.pressed))
  element.appendChild(options.content)

  let pointerHandled = false
  if (options.preserveEditorSelection !== false) {
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      pointerHandled = true
      // Keep ProseMirror's selection active until the toolbar action runs.
      event.preventDefault()
    })
    element.addEventListener('pointerup', (event) => {
      if (event.button !== 0 || !pointerHandled) return
      options.onPress()
    })
    element.addEventListener('pointercancel', () => {
      pointerHandled = false
    })
  }
  element.addEventListener('click', () => {
    if (pointerHandled) {
      pointerHandled = false
      return
    }
    options.onPress()
  })
  return element
}

export function installEditorToolbar(
  host: HTMLElement,
  actions: EditorToolbarActions,
  onPanelVisibilityChange?: (open: boolean) => void
): EditorToolbarController {
  let view: ToolbarView = { kind: 'main' }
  let readOnly = false
  let keyboardVisible = false
  let suppressed = false
  let panelOpen = false
  let keyboardReplacementHeight = 0
  let selection: EditorToolbarSelection = {
    blockLabel: 'T',
    activeStyles: { bold: false, italic: false, underline: false, strike: false, code: false },
    table: null,
    alignment: 'left',
    textColour: 'default',
    backgroundColour: 'default',
    canNest: false,
    canUnnest: false
  }

  const render = (): void => {
    host.replaceChildren()
    host.hidden = readOnly || (!keyboardVisible && !panelOpen) || suppressed
    if (host.hidden) return

    const shell = document.createElement('div')
    shell.className = `editor-toolbar-shell editor-toolbar-shell-${view.kind}`
    shell.appendChild(
      view.kind === 'main' || view.kind === 'blocks' || view.kind === 'table'
        ? mainToolbar()
        : formattingToolbar()
    )

    if (view.kind === 'blocks') shell.appendChild(blockPicker())
    if (view.kind === 'turn-into') shell.appendChild(turnIntoPicker())
    if (view.kind === 'style') shell.appendChild(stylePicker())
    if (view.kind === 'table') shell.appendChild(tablePicker())
    if (view.kind === 'link-prompt') shell.appendChild(linkPrompt())
    host.appendChild(shell)
  }

  const setView = (next: ToolbarView): void => {
    view = next
    const nextPanelOpen =
      next.kind === 'blocks' ||
      next.kind === 'turn-into' ||
      next.kind === 'table' ||
      next.kind === 'style' ||
      next.kind === 'link-prompt'
    if (nextPanelOpen !== panelOpen) {
      panelOpen = nextPanelOpen
      onPanelVisibilityChange?.(panelOpen)
    }
    render()
  }

  const turnIntoButton = (className?: string): HTMLButtonElement => {
    const chip = text(selection.blockLabel, 'editor-block-chip')
    return actionButton({
      label: `Turn into. Current block: ${selection.blockLabel}`,
      content: chip,
      onPress: () => setView({ kind: 'turn-into' }),
      className
    })
  }

  const mainToolbar = (): HTMLElement => {
    const toolbar = document.createElement('div')
    toolbar.className = 'editor-toolbar editor-toolbar-main'
    toolbar.setAttribute('role', 'toolbar')
    toolbar.setAttribute('aria-label', 'Editor')

    toolbar.append(
      actionButton({
        label: 'Insert blocks',
        content: svg(['M12 5v14', 'M5 12h14']),
        onPress: () => {
          if (view.kind === 'blocks') {
            setView({ kind: 'main' })
            return
          }
          keyboardReplacementHeight = Math.max(readHostKeyboardHeight(), readViewportBottomInset())
          setView({ kind: 'blocks' })
          actions.dismissKeyboard()
        },
        pressed: view.kind === 'blocks'
      }),
      actionButton({
        label: 'Formatting',
        content: text('Aa', 'editor-toolbar-aa'),
        onPress: () => setView({ kind: 'formatting' }),
        className: 'editor-toolbar-aa-button'
      }),
      actionButton({
        label: 'Insert wiki link',
        content: text('[[', 'editor-toolbar-wiki'),
        onPress: actions.insertWikiLink
      }),
      actionButton({
        label: 'Insert image',
        content: svg(['M4 5.5h16v13H4z', 'm5 16 4-4 3 3 2-2 5 4', 'M8.5 9h.01']),
        onPress: actions.insertImage
      })
    )

    if (selection.table !== null) {
      toolbar.appendChild(
        actionButton({
          label: 'Table',
          content: text('▦', 'editor-toolbar-table'),
          onPress: () => {
            if (view.kind === 'table') {
              setView({ kind: 'main' })
              return
            }
            // Same keyboard-replacement dance as the block picker: the panel
            // takes the keyboard's space, and ProseMirror keeps its selection
            // across the blur, so the caret is still in the cell the
            // operation applies to.
            keyboardReplacementHeight = Math.max(
              readHostKeyboardHeight(),
              readViewportBottomInset()
            )
            setView({ kind: 'table' })
            actions.dismissKeyboard()
          },
          pressed: view.kind === 'table'
        })
      )
    }

    if (view.kind === 'main') toolbar.appendChild(turnIntoButton())

    const spacer = document.createElement('span')
    spacer.className = 'editor-toolbar-spacer'
    toolbar.append(
      spacer,
      actionButton({
        label: 'Undo',
        content: svg(['M9 7 4 12l5 5', 'M5 12h7a7 7 0 0 1 7 7']),
        onPress: actions.undo,
        className: 'editor-toolbar-history'
      }),
      actionButton({
        label: 'Redo',
        content: svg(['m15 7 5 5-5 5', 'M19 12h-7a7 7 0 0 0-7 7']),
        onPress: actions.redo,
        className: 'editor-toolbar-history'
      }),
      actionButton({
        label: view.kind === 'main' ? 'Hide keyboard' : 'Dismiss picker',
        content:
          view.kind === 'main'
            ? svg(['M4 6h16v10H4z', 'm8 19 4 2 4-2', 'M8 10h.01m4 0h.01m4 0h.01'])
            : svg(['m7 9 5 5 5-5']),
        onPress: () => {
          if (view.kind === 'main') actions.dismissKeyboard()
          else setView({ kind: 'main' })
        },
        className: 'editor-toolbar-history'
      })
    )
    return toolbar
  }

  const formattingToolbar = (): HTMLElement => {
    const toolbar = document.createElement('div')
    toolbar.className = 'editor-toolbar editor-toolbar-formatting'
    toolbar.setAttribute('role', 'toolbar')
    toolbar.setAttribute('aria-label', 'Formatting')
    toolbar.append(
      actionButton({
        label: 'Back to editor toolbar',
        content: svg(['m15 18-6-6 6-6']),
        onPress: () => setView({ kind: 'main' })
      }),
      turnIntoButton('editor-toolbar-format-item')
    )

    const styleButtons: readonly { style: InlineStyle; label: string; glyph: string }[] = [
      { style: 'bold', label: 'Bold', glyph: 'B' },
      { style: 'italic', label: 'Italic', glyph: 'I' },
      { style: 'underline', label: 'Underline', glyph: 'U' },
      { style: 'strike', label: 'Strikethrough', glyph: 'S' }
    ]
    for (const item of styleButtons) {
      toolbar.appendChild(
        actionButton({
          label: item.label,
          content: text(item.glyph, `editor-format-glyph editor-format-${item.style}`),
          onPress: () => actions.toggleStyle(item.style),
          className: 'editor-toolbar-format-item',
          pressed: selection.activeStyles[item.style]
        })
      )
    }

    toolbar.append(
      actionButton({
        label: 'Bulleted list',
        content: svg(['M9 6h11M9 12h11M9 18h11', 'M4 6h.01M4 12h.01M4 18h.01']),
        onPress: actions.toggleBulletedList,
        className: 'editor-toolbar-format-item'
      }),
      actionButton({
        label: 'Link',
        content: svg([
          'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5',
          'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7L12 19'
        ]),
        onPress: () => setView({ kind: 'link-prompt' }),
        className: 'editor-toolbar-format-item'
      }),
      actionButton({
        label: 'Inline code',
        content: svg(['m8 9-3 3 3 3', 'm16 9 3 3-3 3', 'm14 5-4 14']),
        onPress: () => actions.toggleStyle('code'),
        className: 'editor-toolbar-format-item',
        pressed: selection.activeStyles.code
      }),
      // Alignment, colour and indentation are 25 choices between them (#2102).
      // They go behind one disclosure rather than into this row: the row is
      // already at the 44 px touch floor on a phone, and the panel replaces
      // the keyboard, so the paragraph being styled stays on screen.
      actionButton({
        label: 'Style',
        content: svg([
          'M12 4a8 8 0 0 0 0 16 2 2 0 0 0 2-2 2 2 0 0 1 2-2h1a3 3 0 0 0 3-3 9 9 0 0 0-8-9Z',
          'M8 11h.01',
          'M11.5 8h.01',
          'M15 10h.01'
        ]),
        onPress: () => {
          if (view.kind === 'style') {
            setView({ kind: 'formatting' })
            return
          }
          keyboardReplacementHeight = Math.max(readHostKeyboardHeight(), readViewportBottomInset())
          setView({ kind: 'style' })
          actions.dismissKeyboard()
        },
        className: 'editor-toolbar-format-item',
        pressed: view.kind === 'style'
      })
    )
    return toolbar
  }

  const pickerCard = (
    item: PickerVisual,
    onPress: () => void,
    selected = false
  ): HTMLButtonElement => {
    const card = actionButton({
      label: item.label,
      content: document.createDocumentFragment(),
      onPress,
      className: 'editor-picker-card',
      pressed: selected,
      preserveEditorSelection: false
    })
    const glyph = text(item.glyphNode ? '' : item.glyph, 'editor-picker-glyph')
    if (item.glyphNode) glyph.appendChild(item.glyphNode)
    if (item.glyphStyle) glyph.dataset.style = item.glyphStyle
    card.append(glyph, text(item.label, 'editor-picker-label'))
    if (selected) card.appendChild(text('✓', 'editor-picker-check'))
    return card
  }

  const picker = (title: string): HTMLElement => {
    const panel = document.createElement('section')
    panel.className = 'editor-picker'
    panel.setAttribute('aria-label', title)
    const header = document.createElement('div')
    header.className = 'editor-picker-header'
    header.appendChild(text(title))
    panel.appendChild(header)
    return panel
  }

  const blockPicker = (): HTMLElement => {
    const panel = picker('Blocks')
    if (keyboardReplacementHeight > 0) {
      panel.style.setProperty('--memry-picker-height', `${keyboardReplacementHeight}px`)
    }
    const scroll = document.createElement('div')
    scroll.className = 'editor-picker-scroll'
    for (const group of BLOCK_PICKER_GROUPS) {
      const section = document.createElement('section')
      const label = text(group.label, 'editor-picker-section-label')
      const grid = document.createElement('div')
      grid.className = 'editor-picker-grid'
      for (const item of group.items) {
        grid.appendChild(
          pickerCard(item, () => {
            setView({ kind: 'main' })
            actions.insert(item.action)
          })
        )
      }
      section.append(label, grid)
      scroll.appendChild(section)
    }
    panel.appendChild(scroll)
    return panel
  }

  const tablePicker = (): HTMLElement => {
    const panel = picker('Table')
    if (keyboardReplacementHeight > 0) {
      panel.style.setProperty('--memry-picker-height', `${keyboardReplacementHeight}px`)
    }
    const scroll = document.createElement('div')
    scroll.className = 'editor-picker-scroll'
    const locked = selection.table?.structureLocked === true
    if (locked) {
      // Honest rather than silently wrong: the merge came from a desktop the
      // phone cannot re-index, and a "working" button would corrupt the table.
      const note = text(
        'This table has merged cells. Rows and columns can only be changed on desktop.',
        'editor-picker-note'
      )
      note.setAttribute('role', 'note')
      scroll.appendChild(note)
    }
    for (const group of TABLE_PICKER_GROUPS) {
      const items = group.items.filter((item) => !(locked && item.structural))
      if (items.length === 0) continue
      const section = document.createElement('section')
      const grid = document.createElement('div')
      grid.className = 'editor-picker-grid'
      for (const item of items) {
        grid.appendChild(
          pickerCard(item, () => {
            if (item.action.kind !== 'structure') setView({ kind: 'main' })
            actions.tableAction(item.action)
          })
        )
      }
      section.append(text(group.label, 'editor-picker-section-label'), grid)
      scroll.appendChild(section)
    }
    panel.appendChild(scroll)
    return panel
  }

  const turnIntoPicker = (): HTMLElement => {
    const panel = picker('Turn into')
    const scroll = document.createElement('div')
    scroll.className = 'editor-picker-scroll'
    const grid = document.createElement('div')
    grid.className = 'editor-picker-grid'
    for (const item of TURN_INTO_ITEMS) {
      if (item.action.kind !== 'convertible') continue
      const block = item.action.block
      const label = block.kind === 'heading' ? `H${block.level}` : item.glyph
      grid.appendChild(
        pickerCard(
          item,
          () => {
            setView({ kind: 'formatting' })
            actions.turnInto(block)
          },
          selection.blockLabel === label
        )
      )
    }
    scroll.appendChild(grid)
    panel.appendChild(scroll)
    return panel
  }

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
      const button = actionButton({
        label: `${title}: ${colour}`,
        content: swatch(colour),
        onPress: () => onPick(colour),
        className: 'editor-colour-swatch',
        pressed: active === colour,
        preserveEditorSelection: false
      })
      row.appendChild(button)
    }
    section.append(text(title, 'editor-picker-section-label'), row)
    return section
  }

  /**
   * Alignment, colour and indentation (#2102).
   *
   * The panel stays open after every tap, like the table panel's structure
   * rows: these are settings a person nudges and looks at, not one-shot
   * insertions, and re-opening the panel between each nudge would cost four
   * taps to centre and indent one line.
   */
  const stylePicker = (): HTMLElement => {
    const panel = picker('Style')
    if (keyboardReplacementHeight > 0) {
      panel.style.setProperty('--memry-picker-height', `${keyboardReplacementHeight}px`)
    }
    const scroll = document.createElement('div')
    scroll.className = 'editor-picker-scroll'

    if (selection.alignment !== null) {
      const section = document.createElement('section')
      const grid = document.createElement('div')
      grid.className = 'editor-picker-grid'
      for (const alignment of TEXT_ALIGNMENTS) {
        grid.appendChild(
          pickerCard(
            {
              label: ALIGNMENT_LABELS[alignment],
              glyph: '',
              glyphNode: svg(ALIGNMENT_PATHS[alignment])
            },
            () => actions.styleAction({ kind: 'align', alignment }),
            selection.alignment === alignment
          )
        )
      }
      section.append(text('Alignment', 'editor-picker-section-label'), grid)
      scroll.appendChild(section)
    }

    scroll.append(
      colourRow(
        'Text colour',
        selection.textColour,
        (colour) => {
          const chip = text('A', 'editor-colour-chip')
          chip.style.color = COLORS_DEFAULT[colour]?.text ?? 'inherit'
          return chip
        },
        (colour) => actions.styleAction({ kind: 'text-colour', colour })
      ),
      colourRow(
        'Highlight',
        selection.backgroundColour,
        (colour) => {
          const chip = text('A', 'editor-colour-chip')
          chip.style.background = COLORS_DEFAULT[colour]?.background ?? 'transparent'
          return chip
        },
        (colour) => actions.styleAction({ kind: 'background-colour', colour })
      )
    )

    const indent = document.createElement('section')
    const indentGrid = document.createElement('div')
    indentGrid.className = 'editor-picker-grid'
    for (const item of [
      { label: 'Indent', glyph: '⇥', kind: 'nest' as const, enabled: selection.canNest },
      { label: 'Outdent', glyph: '⇤', kind: 'unnest' as const, enabled: selection.canUnnest }
    ]) {
      const card = pickerCard(item, () => actions.styleAction({ kind: item.kind }))
      card.disabled = !item.enabled
      indentGrid.appendChild(card)
    }
    indent.append(text('Indentation', 'editor-picker-section-label'), indentGrid)
    scroll.appendChild(indent)

    panel.appendChild(scroll)
    return panel
  }

  const linkPrompt = (): HTMLElement => {
    const panel = picker('Add link')
    panel.classList.add('editor-link-prompt')
    const form = document.createElement('form')
    form.className = 'editor-link-form'
    const input = document.createElement('input')
    input.type = 'url'
    input.inputMode = 'url'
    input.placeholder = 'https://'
    input.setAttribute('aria-label', 'Link URL')
    const cancel = actionButton({
      label: 'Cancel',
      content: text('Cancel'),
      onPress: () => {
        setView({ kind: 'formatting' })
        actions.focusEditor()
      },
      className: 'editor-link-action'
    })
    const add = actionButton({
      label: 'Add link',
      content: text('Add'),
      onPress: () => {
        const url = input.value.trim()
        if (!url) return
        setView({ kind: 'formatting' })
        actions.createLink(url)
      },
      className: 'editor-link-action editor-link-add'
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const url = input.value.trim()
      if (!url) return
      setView({ kind: 'formatting' })
      actions.createLink(url)
    })
    form.append(input, cancel, add)
    panel.appendChild(form)
    requestAnimationFrame(() => input.focus())
    return panel
  }

  render()
  return {
    update(next) {
      selection = next
      // A caret that has left the table takes the panel with it; the actions
      // in it apply to a cell that is no longer under the cursor.
      if (view.kind === 'table' && next.table === null) {
        setView({ kind: 'main' })
        return
      }
      render()
    },
    setReadOnly(next) {
      readOnly = next
      if (next && panelOpen) {
        setView({ kind: 'main' })
        return
      }
      render()
    },
    setKeyboardVisible(next) {
      keyboardVisible = next
      render()
    },
    setSuppressed(next) {
      suppressed = next
      render()
    },
    isPanelOpen() {
      return panelOpen
    },
    closePanel() {
      setView({ kind: 'main' })
    },
    destroy() {
      if (panelOpen) onPanelVisibilityChange?.(false)
      panelOpen = false
      host.replaceChildren()
      host.hidden = true
    }
  }
}
