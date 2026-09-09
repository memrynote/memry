export type InlineStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code'

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

interface PickerItem {
  label: string
  glyph: string
  action: InsertBlockAction
  glyphStyle?: 'serif' | 'mono'
}

interface PickerGroup {
  label: string
  items: readonly PickerItem[]
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

export interface EditorToolbarSelection {
  blockLabel: string
  activeStyles: Readonly<Record<InlineStyle, boolean>>
}

export interface EditorToolbarActions {
  insert(action: InsertBlockAction): void
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
    activeStyles: { bold: false, italic: false, underline: false, strike: false, code: false }
  }

  const render = (): void => {
    host.replaceChildren()
    host.hidden = readOnly || (!keyboardVisible && !panelOpen) || suppressed
    if (host.hidden) return

    const shell = document.createElement('div')
    shell.className = `editor-toolbar-shell editor-toolbar-shell-${view.kind}`
    shell.appendChild(
      view.kind === 'main' || view.kind === 'blocks' ? mainToolbar() : formattingToolbar()
    )

    if (view.kind === 'blocks') shell.appendChild(blockPicker())
    if (view.kind === 'turn-into') shell.appendChild(turnIntoPicker())
    if (view.kind === 'link-prompt') shell.appendChild(linkPrompt())
    host.appendChild(shell)
  }

  const setView = (next: ToolbarView): void => {
    view = next
    const nextPanelOpen =
      next.kind === 'blocks' || next.kind === 'turn-into' || next.kind === 'link-prompt'
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

    if (view.kind !== 'blocks') toolbar.appendChild(turnIntoButton())

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
        label: view.kind === 'blocks' ? 'Dismiss picker' : 'Hide keyboard',
        content:
          view.kind === 'blocks'
            ? svg(['m7 9 5 5 5-5'])
            : svg(['M4 6h16v10H4z', 'm8 19 4 2 4-2', 'M8 10h.01m4 0h.01m4 0h.01']),
        onPress: () => {
          if (view.kind === 'blocks') setView({ kind: 'main' })
          else actions.dismissKeyboard()
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
      })
    )
    return toolbar
  }

  const pickerCard = (item: PickerItem, onPress: () => void, selected = false): HTMLElement => {
    const card = actionButton({
      label: item.label,
      content: document.createDocumentFragment(),
      onPress,
      className: 'editor-picker-card',
      pressed: selected,
      preserveEditorSelection: false
    })
    const glyph = text(item.glyph, 'editor-picker-glyph')
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
