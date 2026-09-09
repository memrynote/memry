import { parseWikiLinkText } from '@memry/editor-schema/inline'
import { getTagColors } from '@memry/contracts/tag-colors'
import type { InlineMenuTrigger, WikiCandidate } from '@memry/contracts/webview-bridge'
import type { GuestBridge } from './bridge.ts'

/**
 * Wiki-links in the WebView (T067 web half; FR-014).
 *
 * Two halves, both bridge-mediated because the WebView has no vault access:
 *   * tap → `nav` message; RN routes, including `Title#Heading` targets.
 *   * `[[` → `wiki-query` / `wiki-candidates` autocomplete.
 *
 * The same autocomplete serves `#` tags and `@` note mentions (#2099). They
 * share every hard part — the debounce, the abandoned-query heuristic, the
 * reqId round trip, the caret-relative delete — and differ only in what a row
 * means and what accepting one writes, so one menu owns all three triggers
 * rather than three that can disagree about which of them is open.
 *
 * The inserted node is built with `createWikiLinkInlineContent` from the shared
 * package, so the alias and the on-disk form are exactly what desktop writes.
 * The DISPLAYED text is the alias, never the target — see the shared spec.
 */

const OPEN_TOKEN = '[['
/**
 * The rest of an open run, from the caret through its `]]`.
 *
 * Group 1 is whatever sits between, which after an un-promotion is the
 * `|Alias` the user had already written. Brackets are excluded so this can
 * never reach across into a neighbouring link's closer.
 */
const RUN_TAIL = /^([^[\]\n]*)\]\]/

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

/**
 * `#tag` before the caret. The character class is desktop's `TAG_CHAR_PATTERN`
 * (`hash-tag-inline-plugin.ts`), so the phone offers exactly the names the
 * desktop would let the user type, and a space ends the tag on both.
 *
 * The opener class carries `\ufffc`, the object-replacement character an atom
 * renders as, so a `#` typed straight after a finished chip still opens.
 */
const TAG_RUN = /(?:^|[\s\ufffc([{"'])#([a-zA-Z0-9_\-/]*)$/

/**
 * `@query` before the caret. Note titles have spaces in them, so unlike a tag
 * this runs on until `ABANDONED_QUERY` says the user has moved on. Excluding
 * `@` from the class is what makes the LAST one win in `a@b @c`.
 */
const MENTION_RUN = /(?:^|[\s\ufffc([{"'])@([^@\n]*)$/

/** An icon prop that is a name in desktop's registry rather than an emoji. */
const ICON_NAME = /^[A-Za-z0-9._-]+$/

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
  /** The text between the trigger that opened the menu and the caret. */
  query: string
  reqId: string
  trigger: InlineMenuTrigger
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
  /**
   * Replace the raw `[[query]]` run around the cursor with a wiki link.
   *
   * `back` and `forward` are character counts either side of the caret. The
   * caller runs both the delete and the insert inside ONE editor transaction:
   * driving the delete with `execCommand` looked fine for a short query and
   * then silently did nothing for a longer one, leaving `[[Note#` stranded in
   * front of the finished chip.
   */
  replaceQuery(back: number, forward: number, target: string, alias: string): void
  /**
   * The same replacement, writing a `hashTag` node instead of a wiki link.
   *
   * `color` and `icon` are carried rather than derived: they are what the
   * vault's `tag_definition` row says, so the chip this phone writes is the
   * one every other device already paints for that tag.
   */
  replaceQueryWithTag(back: number, forward: number, tag: string, color: string, icon: string): void
  /**
   * Turn an adjacent finished wiki link back into `[[…]]` text, caret at the
   * end of its target. `false` when there is no link on that side.
   */
  unpromoteAdjacent(direction: 'before' | 'after'): boolean
}

export interface WikiLinkAutocomplete {
  /**
   * Open the menu against whatever `[[` already sits before the caret.
   *
   * The toolbar button needs this. It inserts `[[` with `execCommand`, and
   * ProseMirror handles that `beforeinput` itself — no `input` event reaches
   * this module, so the typing path never fires and the user was left with two
   * bare brackets and no menu.
   */
  open(): void
  close(): void
  detach(): void
}

/**
 * Where the menu listens and where it draws are three different elements.
 *
 * `root` is the mounted editor, and it is as tall as the whole note, because
 * the RN side scrolls the WebView's own frame rather than a scroller inside
 * it. A `position: fixed` child of it anchors to the bottom of that tall
 * frame, metres below anything on screen -- which is why the menu appeared to
 * do nothing while Enter still committed the highlighted note. `chrome` is the
 * layer the toolbar already uses to stay pinned to the visible viewport, so
 * the menu is drawn there. `toolbarHost` is measured, not written to: it is
 * the only honest source for where the toolbar's top edge currently is, and
 * that moves with the keyboard, the safe area and an open block picker.
 */
export interface WikiLinkHosts {
  root: HTMLElement
  chrome: HTMLElement
  toolbarHost: HTMLElement
}

export function installWikiLinkAutocomplete(
  editor: WikiLinkEditorSurface,
  bridge: GuestBridge,
  hosts: WikiLinkHosts
): WikiLinkAutocomplete {
  const { root, chrome, toolbarHost } = hosts
  const menu = document.createElement('div')
  menu.className = 'wiki-menu'
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-label', 'Link to note')
  menu.hidden = true
  chrome.appendChild(menu)

  let state: AutocompleteState | null = null
  let rows: WikiCandidate[] = []
  let selected = 0
  let reqCounter = 0
  let debounce: ReturnType<typeof setTimeout> | null = null

  const close = (): void => {
    if (debounce !== null) {
      clearTimeout(debounce)
      debounce = null
    }
    state = null
    rows = []
    selected = 0
    menu.hidden = true
    menu.replaceChildren()
  }

  const insert = (candidate: WikiCandidate): void => {
    // `empty` rows are messages, not targets. Desktop makes the same row
    // unselectable rather than closing the menu the user is still typing into.
    if (!state || !candidate.target) return
    const trigger = state.trigger
    // `#` and `@` are one character; `[[` is two. Everything else about the
    // backwards delete is the same, and getting this wrong eats the character
    // in front of the trigger.
    const back = (trigger === 'wiki' ? OPEN_TOKEN.length : 1) + state.query.length
    // The tail is read from the DOM rather than remembered from whoever opened
    // the menu: the toolbar writes `[[]]`, a user can type the brackets by
    // hand, and an un-promoted link arrives with `|Alias]]` already after the
    // caret. All three have to leave the same document behind. `#` and `@`
    // have no closer, so there is never anything past the caret to eat.
    const tail = trigger === 'wiki' ? RUN_TAIL.exec(textAfterCaret()) : null
    const forward = tail ? tail[0].length : 0
    const written = tail?.[1]?.startsWith('|') ? tail[1].slice(1).trim() : ''
    close()
    if (trigger === 'tag') {
      editor.replaceQueryWithTag(
        back,
        forward,
        candidate.target,
        candidate.color ?? '',
        candidate.icon
      )
      return
    }
    // A row that names its own label (a heading, an explicit alias) wins; a
    // plain note row keeps whatever the user had already written, so re-picking
    // the target of `[[Old|my label]]` does not silently drop the label. An
    // `@` mention is a note row, so it takes the plain-title branch — the same
    // wiki link desktop's mention menu writes.
    editor.replaceQuery(back, forward, candidate.target, candidate.alias || written)
  }

  const paintSelection = (): void => {
    const items = menu.querySelectorAll('.wiki-menu-item')
    items.forEach((item, index) => {
      item.classList.toggle('is-selected', index === selected)
      item.setAttribute('aria-selected', index === selected ? 'true' : 'false')
    })
  }

  const renderCandidates = (items: WikiCandidate[]): void => {
    menu.replaceChildren()
    if (items.length === 0) {
      close()
      return
    }
    rows = items
    selected = items.findIndex((item) => item.kind !== 'empty')
    menu.setAttribute('aria-label', MENU_LABEL[state?.trigger ?? 'wiki'])
    for (const item of items) {
      menu.appendChild(candidateRow(item, () => insert(item)))
    }
    // The pipe is the only part of the grammar with no visible affordance, so
    // it gets a standing hint the way desktop's menu footer does. `#` and `@`
    // have no such grammar, so they get no footer.
    if (state?.trigger === 'wiki') {
      const hint = document.createElement('div')
      hint.className = 'wiki-menu-hint'
      hint.textContent = 'Type | to name the link'
      menu.appendChild(hint)
    }
    paintSelection()
    // The SHELL, not the host: the shell is absolutely positioned, so the host
    // div wrapping it is zero-high and measuring it put the menu underneath the
    // toolbar it was supposed to sit on top of.
    const shell = toolbarHost.querySelector('.editor-toolbar-shell')
    const top = shell?.getBoundingClientRect().top
    // A hidden toolbar has no box, and the stylesheet's own bottom inset is
    // the right answer then.
    menu.style.insetBlockEnd = top === undefined ? '' : `${Math.max(0, window.innerHeight - top)}px`
    menu.hidden = false
  }

  const unsubscribe = bridge.onHostMsg((msg) => {
    if (msg.type !== 'wiki-candidates') return
    if (!state || msg.reqId !== state.reqId) return
    renderCandidates(msg.items)
  })

  const refresh = (): void => {
    const opened = detectTrigger(textBeforeCaret())
    if (!opened) {
      close()
      return
    }
    const { trigger, query } = opened

    const reqId = `w${++reqCounter}`
    // A trigger change counts as a first request even though a menu is already
    // up: the rows on screen answer a different question, and debouncing the
    // replacement leaves tags showing under an `@`.
    const first = state === null || state.trigger !== trigger
    state = { query, reqId, trigger }
    if (debounce !== null) clearTimeout(debounce)
    const ask = (): void => {
      debounce = null
      // Only if this is still the query the user is typing: a stale request
      // would repaint the menu with results for text that is already gone.
      if (state?.reqId === reqId) bridge.send({ type: 'wiki-query', reqId, query, trigger })
    }
    // The first request opens the menu, so it skips the debounce: waiting
    // 120 ms to show anything reads as the button having done nothing.
    if (first) ask()
    else debounce = setTimeout(ask, QUERY_DEBOUNCE_MS)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    // Before the menu's own keys: a finished link next to the caret is only
    // ever adjacent when no query is open, so the two cannot both fire.
    const unpromote =
      event.key === 'Backspace' || event.key === 'ArrowLeft'
        ? 'before'
        : event.key === 'ArrowRight'
          ? 'after'
          : null
    if (unpromote && editor.unpromoteAdjacent(unpromote)) {
      event.preventDefault()
      refresh()
      return
    }
    if (!state || rows.length === 0) return
    const selectable = rows.filter((row) => row.target).length
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (selectable === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      do {
        selected = (selected + step + rows.length) % rows.length
      } while (!rows[selected]?.target)
      paintSelection()
      return
    }
    if (event.key === 'Enter' && !event.isComposing) {
      const candidate = rows[selected]
      if (!candidate?.target) return
      event.preventDefault()
      insert(candidate)
    }
  }

  root.addEventListener('input', refresh)
  // Capture, not bubble. ProseMirror's own keydown handler is bound to the
  // contenteditable, which is BELOW `root` in the tree, so a bubbling listener
  // runs after it has already deleted the chip and `preventDefault` is too
  // late. The whole point here is to get in front of it.
  root.addEventListener('keydown', onKeyDown, true)

  return {
    open: refresh,
    close,
    detach: () => {
      unsubscribe()
      root.removeEventListener('input', refresh)
      root.removeEventListener('keydown', onKeyDown, true)
      menu.remove()
    }
  }
}

const MENU_LABEL: Record<InlineMenuTrigger, string> = {
  wiki: 'Link to note',
  tag: 'Add a tag',
  mention: 'Mention a note'
}

/**
 * Which inline menu the caret is currently inside, if any.
 *
 * `[[` is asked first and wins outright whenever it is open, because `#` and
 * `|` are both part of its own grammar: without that precedence, typing
 * `[[Note#` would swap the heading list for the vault's tags mid-word.
 *
 * Between `#` and `@` the one NEARER the caret wins, so `#tag @no` opens the
 * mention menu and backspacing back over the `@` returns to the tag.
 */
export function detectTrigger(text: string): { trigger: InlineMenuTrigger; query: string } | null {
  const openAt = text.lastIndexOf(OPEN_TOKEN)
  if (openAt !== -1) {
    const query = text.slice(openAt + OPEN_TOKEN.length)
    // A completed `[[X]]` is not an open menu — it is a link the user finished
    // typing by hand, which the spec's own parse rule promotes. A query that
    // has run away into ordinary prose is not one either.
    if (
      !query.includes(']]') &&
      !ABANDONED_QUERY.test(query) &&
      !parseWikiLinkText(text.slice(openAt))
    ) {
      return { trigger: 'wiki', query }
    }
  }

  const tag = TAG_RUN.exec(text)?.[1]
  const mentionMatch = MENTION_RUN.exec(text)?.[1]
  const mention =
    mentionMatch !== undefined && !ABANDONED_QUERY.test(mentionMatch) ? mentionMatch : undefined

  if (tag !== undefined && mention !== undefined) {
    // Both are anchored at the caret, so the longer query started further back.
    return tag.length < mention.length
      ? { trigger: 'tag', query: tag }
      : { trigger: 'mention', query: mention }
  }
  if (tag !== undefined) return { trigger: 'tag', query: tag }
  if (mention !== undefined) return { trigger: 'mention', query: mention }
  return null
}

function candidateRow(item: WikiCandidate, onAccept: () => void): HTMLElement {
  if (item.kind === 'empty') {
    const message = document.createElement('div')
    message.className = 'wiki-menu-empty'
    message.textContent = item.title
    return message
  }

  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'wiki-menu-item'
  row.setAttribute('role', 'option')

  const glyph = document.createElement('span')
  glyph.className = 'wiki-menu-glyph'
  // The note's or tag's own emoji when it has one, so a row reads the same
  // here as it does in the notes tree. An icon NAME addresses desktop's
  // HugeIcon registry, which this bundle does not carry — the same rule
  // `inline.ts` applies when it paints a chip. Everything else falls back to a
  // kind marker, and a tag's marker is painted in the tag's own colour.
  const emoji = item.icon && !ICON_NAME.test(item.icon) ? item.icon : ''
  glyph.textContent = emoji || ROW_GLYPH[item.kind]
  if (item.kind === 'tag' && !emoji) {
    glyph.style.color = getTagColors(item.color ?? '', item.title).text
    glyph.style.opacity = '1'
  }
  row.appendChild(glyph)

  const label = document.createElement('span')
  label.className = 'wiki-menu-label'
  // The `#` is part of how a tag reads everywhere else in Memry, and the row
  // is the only place the user sees the name before committing to it.
  label.textContent = item.kind === 'tag' ? `#${item.title}` : item.title
  if (item.kind === 'heading' && item.headingLevel && item.headingLevel > 1) {
    label.style.paddingInlineStart = `${Math.min(item.headingLevel - 1, 3) * 10}px`
  }
  row.appendChild(label)

  if (item.subtitle) {
    const sub = document.createElement('span')
    sub.className = 'wiki-menu-sub'
    sub.textContent = item.subtitle
    row.appendChild(sub)
  }

  // `pointerdown`: a `click` on a button inside a contenteditable loses the
  // selection first, and the insert then lands at the wrong offset.
  row.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    onAccept()
  })
  return row
}

const ROW_GLYPH: Record<WikiCandidate['kind'], string> = {
  note: '\u25e6',
  heading: '#',
  alias: '\u21b3',
  create: '+',
  empty: '',
  tag: '\u25cf'
}

/**
 * Text of the current block from the caret to the end of its text node.
 *
 * Only used to spot the `]]` the toolbar left in front of the caret, so the
 * accept path can eat it instead of stranding it next to the finished chip.
 */
function textAfterCaret(): string {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return ''
  const anchor = selection.anchorNode
  if (!anchor) return ''

  const block = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest(
    '[data-node-type], p, h1, h2, h3, li, blockquote'
  )
  if (!block) return ''

  let out = ''
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  let seen = false
  while (node) {
    if (node === anchor) {
      out += (node.textContent ?? '').slice(selection.anchorOffset)
      seen = true
    } else if (seen) {
      out += node.textContent ?? ''
    }
    node = walker.nextNode()
  }
  return out
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
