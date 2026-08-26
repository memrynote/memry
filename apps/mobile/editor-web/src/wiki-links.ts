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
 * The two editor operations the menu needs, supplied by the caller.
 *
 * Not the editor itself: BlockNote's editor type is parameterised by the
 * custom schema, so a structural stand-in for it cannot be written without
 * restating the whole schema — and `insertInlineContent` in particular is
 * typed against the schema's own inline union. Handing over two closures keeps
 * the schema-typed calls at the one site that already knows the schema.
 */
export interface WikiLinkEditorSurface {
  /** Text of the block the cursor is in; `''` when there is no cursor. */
  currentBlockText(): string
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

  const close = (): void => {
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
    const text = editor.currentBlockText()
    const openAt = text.lastIndexOf(OPEN_TOKEN)
    if (openAt === -1) {
      close()
      return
    }
    const query = text.slice(openAt + OPEN_TOKEN.length)
    // A completed `[[X]]` is not an open menu — it is a link the user finished
    // typing by hand, which the spec's own parse rule promotes.
    if (query.includes(']]') || parseWikiLinkText(text.slice(openAt))) {
      close()
      return
    }
    const reqId = `w${++reqCounter}`
    state = { query, reqId }
    bridge.send({ type: 'wiki-query', reqId, query })
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
