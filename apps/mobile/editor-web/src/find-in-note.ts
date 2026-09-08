const QUERY_DEBOUNCE_MS = 150
const MUTATION_DEBOUNCE_MS = 300
const MATCHES_HIGHLIGHT = 'memry-find-matches'
const CURRENT_HIGHLIGHT = 'memry-find-current'
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL'
])

export interface FindInNoteState {
  open: boolean
  query: string
  matchCount: number
  currentIndex: number
}

export interface FindInNoteController {
  open(): void
  close(): void
  destroy(): void
}

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null
}

/** Text ranges only; creating them does not mutate ProseMirror's managed DOM. */
export function findTextRanges(element: HTMLElement, query: string): Range[] {
  if (query.length === 0) return []
  const needle = query.toLocaleLowerCase()
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const groups: { owner: Element | null; parts: { node: Text; value: string }[] }[] = []

  let node: Node | null
  while ((node = walker.nextNode())) {
    if (!(node instanceof Text)) continue
    let owner = node.parentElement
    let blockOwner: Element | null = null
    while (owner && owner !== element) {
      if (!blockOwner && BLOCK_TAGS.has(owner.tagName)) blockOwner = owner
      owner = owner.parentElement
    }
    const group = groups.at(-1)
    if (!group || group.owner !== blockOwner) groups.push({ owner: blockOwner, parts: [] })
    groups.at(-1)!.parts.push({ node, value: node.data })
  }

  const ranges: Range[] = []
  for (const group of groups) {
    const source = group.parts.map((part) => part.value).join('')
    const haystack = source.toLocaleLowerCase()
    const positions: { node: Text; start: number; end: number }[] = []
    let foldedOffset = 0
    for (const part of group.parts) {
      let partOffset = 0
      for (const character of part.value) {
        const foldedLength = character.toLocaleLowerCase().length
        for (let index = foldedOffset; index < foldedOffset + foldedLength; index += 1) {
          positions[index] = {
            node: part.node,
            start: partOffset,
            end: partOffset + character.length
          }
        }
        partOffset += character.length
        foldedOffset += foldedLength
      }
    }

    let from = 0
    while (from < haystack.length) {
      const index = haystack.indexOf(needle, from)
      if (index === -1) break
      const start = positions[index]
      const end = positions[index + needle.length - 1]
      if (start && end) {
        const range = new Range()
        range.setStart(start.node, start.start)
        range.setEnd(end.node, end.end)
        ranges.push(range)
      }
      from = index + 1
    }
  }
  return ranges
}

function icon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const data of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', data)
    svg.appendChild(path)
  }
  return svg
}

function button(label: string, glyph: Node, onPress: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = 'editor-find-button'
  element.setAttribute('aria-label', label)
  element.appendChild(glyph)
  element.addEventListener('click', onPress)
  return element
}

/**
 * Current-note find bar. It searches the rendered editor so it includes live,
 * not-yet-persisted edits and every custom block's visible text.
 */
export function installFindInNote(
  host: HTMLElement,
  editorRoot: HTMLElement,
  onStateChange?: (state: FindInNoteState) => void
): FindInNoteController {
  let state: FindInNoteState = { open: false, query: '', matchCount: 0, currentIndex: -1 }
  let matches: Range[] = []
  let queryTimer: ReturnType<typeof setTimeout> | null = null
  let mutationTimer: ReturnType<typeof setTimeout> | null = null
  let focusFrame: number | null = null

  const emit = (): void => onStateChange?.(state)

  const clearHighlights = (): void => {
    const registry = highlightRegistry()
    registry?.delete(MATCHES_HIGHLIGHT)
    registry?.delete(CURRENT_HIGHLIGHT)
  }

  const highlightCurrent = (): void => {
    const registry = highlightRegistry()
    registry?.delete(CURRENT_HIGHLIGHT)
    const range = matches[state.currentIndex]
    if (!range) return
    if (registry && typeof Highlight !== 'undefined') {
      registry.set(CURRENT_HIGHLIGHT, new Highlight(range))
    }
    if (typeof range.getBoundingClientRect === 'function') {
      const rect = range.getBoundingClientRect()
      const margin = 24
      const top = rect.top < margin ? rect.top - margin : 0
      const bottom =
        rect.bottom > window.innerHeight - margin ? rect.bottom - window.innerHeight + margin : 0
      if (top !== 0 || bottom !== 0) {
        window.scrollBy({ top: top || bottom, behavior: 'smooth' })
      }
    }
  }

  const renderCount = (): void => {
    const count = host.querySelector<HTMLElement>('.editor-find-count')
    if (!count) return
    count.textContent = state.query
      ? state.matchCount > 0
        ? `${state.currentIndex + 1}/${state.matchCount}`
        : '0'
      : ''
  }

  const search = (query: string): void => {
    clearHighlights()
    matches = findTextRanges(editorRoot, query)
    state = {
      ...state,
      query,
      matchCount: matches.length,
      currentIndex: matches.length > 0 ? 0 : -1
    }
    const registry = highlightRegistry()
    if (matches.length > 0 && registry && typeof Highlight !== 'undefined') {
      registry.set(MATCHES_HIGHLIGHT, new Highlight(...matches))
    }
    renderCount()
    highlightCurrent()
    emit()
  }

  const cancelQueryTimer = (): void => {
    if (queryTimer !== null) clearTimeout(queryTimer)
    queryTimer = null
  }

  const scheduleSearch = (query: string): void => {
    cancelQueryTimer()
    queryTimer = setTimeout(() => {
      queryTimer = null
      search(query)
    }, QUERY_DEBOUNCE_MS)
  }

  const move = (delta: -1 | 1): void => {
    if (queryTimer !== null) {
      cancelQueryTimer()
      const input = host.querySelector<HTMLInputElement>('.editor-find-input')
      search(input?.value ?? state.query)
    }
    if (matches.length === 0) return
    const current = state.currentIndex < 0 ? 0 : state.currentIndex
    state = { ...state, currentIndex: (current + delta + matches.length) % matches.length }
    renderCount()
    highlightCurrent()
    emit()
  }

  const close = (): void => {
    cancelQueryTimer()
    if (mutationTimer !== null) clearTimeout(mutationTimer)
    mutationTimer = null
    if (focusFrame !== null) cancelAnimationFrame(focusFrame)
    focusFrame = null
    host.querySelector<HTMLInputElement>('.editor-find-input')?.blur()
    clearHighlights()
    matches = []
    state = { open: false, query: '', matchCount: 0, currentIndex: -1 }
    host.replaceChildren()
    host.hidden = true
    emit()
  }

  const open = (): void => {
    if (state.open) {
      host.querySelector<HTMLInputElement>('.editor-find-input')?.focus()
      return
    }
    state = { open: true, query: '', matchCount: 0, currentIndex: -1 }
    host.hidden = false

    const shell = document.createElement('div')
    shell.className = 'editor-find-shell'
    shell.setAttribute('role', 'search')

    const input = document.createElement('input')
    input.type = 'search'
    input.inputMode = 'search'
    input.autocomplete = 'off'
    input.autocapitalize = 'off'
    input.spellcheck = false
    input.placeholder = 'Find in note'
    input.className = 'editor-find-input'
    input.setAttribute('aria-label', 'Find in note')
    input.addEventListener('input', () => scheduleSearch(input.value))
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        move(event.shiftKey ? -1 : 1)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    })

    const count = document.createElement('span')
    count.className = 'editor-find-count'
    count.setAttribute('aria-live', 'polite')

    const previous = button('Previous match', icon(['m18 15-6-6-6 6']), () => move(-1))
    const next = button('Next match', icon(['m6 9 6 6 6-6']), () => move(1))
    const done = button('Done', document.createTextNode('Done'), close)
    done.classList.add('editor-find-done')
    shell.append(input, count, previous, next, done)
    host.replaceChildren(shell)
    emit()
    focusFrame = requestAnimationFrame(() => {
      focusFrame = null
      input.focus()
    })
  }

  const observer = new MutationObserver(() => {
    if (!state.open || !state.query) return
    if (mutationTimer !== null) clearTimeout(mutationTimer)
    mutationTimer = setTimeout(() => {
      mutationTimer = null
      search(state.query)
    }, MUTATION_DEBOUNCE_MS)
  })
  observer.observe(editorRoot, { childList: true, subtree: true, characterData: true })

  host.hidden = true
  return {
    open,
    close,
    destroy: () => {
      observer.disconnect()
      close()
    }
  }
}
