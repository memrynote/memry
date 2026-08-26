import { parseWikiLinkText } from '@memry/editor-schema/inline'
import type { WikiCandidate } from '@memry/contracts/webview-bridge'
import type { GuestBridge } from './bridge.ts'

/**
 * Wiki-links in the WebView (T067 web half; FR-014).
 *
 * Two halves, both bridge-mediated because the WebView has no vault access:
 *   * tap → `nav` message; RN routes, including `Title#Heading` targets.
 *   * `[[` → `wiki-query` / `wiki-candidates` autocomplete.
 *
 * The inserted node is built with `createWikiLinkInlineContent` from the shared
 * package, so the alias and the on-disk form are exactly what desktop writes.
 * The DISPLAYED text is the alias, never the target — see the shared spec.
 */

const OPEN_TOKEN = '[['

/**
 * Wait this long after the last keystroke before asking RN for candidates.
 *
 * The host answers with a scan over every note's payload, so a query per
 * keystroke is a full table scan per keystroke — on the one code path that has
 * to stay under a 50 ms budget.
 */
const QUERY_DEBOUNCE_MS = 120

/**
 * A wiki link target has no newline in it, and a run of spaces means the user
 * typed `[[` and moved on. Without this the menu stays open for the rest of
 * the paragraph, re-querying the whole vault as they type.
 */
const ABANDONED_QUERY = /\n|\s{2,}/

export function installWikiLinkNavigation(root: HTMLElement, bridge: GuestBridge): () => void {
  const onPointerUp = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const chip = target.closest('[data-wiki-link]')
    if (!(chip instanceof HTMLElement)) return
    const value = chip.getAttribute('data-target')?.trim()
    if (!value) return
    // `pointerup`, not `click`: the chip is `contenteditable=false`, and on iOS
    // the selection change between pointerdown and click can move the node out
    // from under the click target — the same class of bug the desktop
    // decoration hit. Flushing immediately keeps navigation off the 24 ms
    // batching delay, which is perceptible on a tap.
    event.preventDefault()
    bridge.send({ type: 'nav', target: value })
    bridge.flush()
  }
  root.addEventListener('pointerup', onPointerUp)
  return () => root.removeEventListener('pointerup', onPointerUp)
}

interface AutocompleteState {
  /** Offset of the `[[` that opened the menu, within the current block's text. */
  query: string
  reqId: string
}

/**
 * The one editor operation the menu needs, supplied by the caller.
 *
 * Not the editor itself: BlockNote's editor type is parameterised by the
 * custom schema, so a structural stand-in cannot be written without restating
 * the whole schema — `insertInlineContent` is typed against the schema's own
 * inline union. Handing over one closure keeps the schema-typed call at the
 * site that already knows the schema.
 *
 * The QUERY is read from the DOM selection instead (see `textBeforeCaret`),
 * not from the block's content: the deletion below runs backwards from the
 * caret, so anything that reads past the caret makes the two disagree and a
 * `[[` typed mid-paragraph eats the text that followed it.
 */
export interface WikiLinkEditorSurface {
  /** Insert a wiki link to `title` at the cursor, followed by a space. */
  insertWikiLink(title: string): void
}

export function installWikiLinkAutocomplete(
  editor: WikiLinkEditorSurface,
  bridge: GuestBridge,
  root: HTMLElement
): () => void {
  const menu = document.createElement('div')
  menu.className = 'wiki-menu'
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-label', 'Link to note')
  menu.hidden = true
  root.appendChild(menu)

  let state: AutocompleteState | null = null
  let reqCounter = 0
  let debounce: ReturnType<typeof setTimeout> | null = null

  const close = (): void => {
    if (debounce !== null) {
      clearTimeout(debounce)
      debounce = null
    }
    state = null
    menu.hidden = true
    menu.replaceChildren()
  }

  const insert = (candidate: WikiCandidate): void => {
    if (!state) return
    const consumed = OPEN_TOKEN.length + state.query.length
    close()
    // Remove the typed `[[query` before inserting the node, or the raw token
    // survives next to the chip and the file gets both forms.
    for (let i = 0; i < consumed; i++) {
      document.execCommand('delete')
    }
    editor.insertWikiLink(candidate.title)
  }

  const renderCandidates = (items: WikiCandidate[]): void => {
    menu.replaceChildren()
    if (items.length === 0) {
      close()
      return
    }
    for (const item of items) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'wiki-menu-item'
      row.setAttribute('role', 'option')
      row.textContent = item.folderPath ? `${item.title} — ${item.folderPath}` : item.title
      // `pointerdown`: a `click` on a button inside a contenteditable loses the
      // selection first, and the insert then lands at the wrong offset.
      row.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        insert(item)
      })
      menu.appendChild(row)
    }
    menu.hidden = false
  }

  const unsubscribe = bridge.onHostMsg((msg) => {
    if (msg.type !== 'wiki-candidates') return
    if (!state || msg.reqId !== state.reqId) return
    renderCandidates(msg.items)
  })

  const onInput = (): void => {
    const text = textBeforeCaret()
    const openAt = text.lastIndexOf(OPEN_TOKEN)
    if (openAt === -1) {
      close()
      return
    }
    const query = text.slice(openAt + OPEN_TOKEN.length)
    // A completed `[[X]]` is not an open menu — it is a link the user finished
    // typing by hand, which the spec's own parse rule promotes. A query that
    // has run away into ordinary prose is not one either.
    if (
      query.includes(']]') ||
      ABANDONED_QUERY.test(query) ||
      parseWikiLinkText(text.slice(openAt))
    ) {
      close()
      return
    }

    const reqId = `w${++reqCounter}`
    state = { query, reqId }
    if (debounce !== null) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      // Only if this is still the query the user is typing: a stale request
      // would repaint the menu with results for text that is already gone.
      if (state?.reqId === reqId) bridge.send({ type: 'wiki-query', reqId, query })
    }, QUERY_DEBOUNCE_MS)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && state) {
      event.preventDefault()
      close()
    }
  }

  root.addEventListener('input', onInput)
  root.addEventListener('keydown', onKeyDown)

  return () => {
    unsubscribe()
    root.removeEventListener('input', onInput)
    root.removeEventListener('keydown', onKeyDown)
    menu.remove()
  }
}

/**
 * Text of the current block up to (and not past) the caret.
 *
 * The caret position is the whole point: `insert` removes exactly
 * `'[['.length + query.length` characters BACKWARDS from the caret, so a query
 * that included text after the caret would delete that much of the following
 * sentence instead.
 */
function textBeforeCaret(): string {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return ''

  const anchor = selection.anchorNode
  if (!anchor) return ''

  // A collapsed caret inside a text node: everything before the offset, plus
  // the preceding text of the same block for a `[[` typed across a mark
  // boundary (bold, a colour) that split the run into two nodes.
  const block = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest(
    '[data-node-type], p, h1, h2, h3, li, blockquote'
  )
  if (!block) return ''

  let out = ''
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node === anchor) {
      out += (node.textContent ?? '').slice(0, selection.anchorOffset)
      break
    }
    out += node.textContent ?? ''
    node = walker.nextNode()
  }
  return out
}
