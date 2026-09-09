import { extractYouTubeVideoId } from '@memry/shared/youtube'
import type { LinkPreview } from '@memry/contracts/webview-bridge'
import type { GuestBridge } from './bridge.ts'
import { icon, type IconName } from './icons.ts'

/**
 * The paste-link menu in the WebView (#2104).
 *
 * Desktop offers a choice the moment a bare URL is pasted — plain URL, link
 * mention, video embed, bookmark (`paste-link-menu.tsx`) — and mobile could
 * RENDER the resulting `bookmark` and `youtubeEmbed` blocks (`blocks.ts`) with
 * no way at all to make one. This is that way.
 *
 * Three things differ from desktop, and each one is the phone rather than a
 * simplification:
 *
 *   * The paste is never intercepted. Desktop can afford to decide before the
 *     text lands because a keyboard user is still holding the menu's arrow
 *     keys; here the URL is pasted normally and the strip offers to CONVERT
 *     what is already in the document. Dismissing it therefore leaves the
 *     reader with exactly what they pasted, which is what `url` means.
 *   * There is no keyboard navigation. Rows are tapped, and they commit on
 *     `pointerdown` for the same reason the wiki-link rows do: a `click` inside
 *     a contenteditable loses the selection first.
 *   * Bookmark and mention metadata comes from the HOST over
 *     `link-preview-req`. The guest has no network by contract, and this is the
 *     only bridge message that reaches a third-party server — so it is sent
 *     only after the reader has tapped one of those two rows, never on paste
 *     and never on open.
 */

export type PasteLinkOption = 'mention' | 'embed' | 'bookmark' | 'url'

/**
 * A pasted URL and nothing else.
 *
 * Deliberately as strict as desktop's: a paragraph that merely CONTAINS a link
 * is prose, and popping a menu over it would fire on every quoted passage.
 */
const URL_ONLY = /^https?:\/\/\S+$/

/** `example.com`, or `''` when the URL will not parse. */
export function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The rows to offer, in desktop's order.
 *
 * `embed` is URL-pattern only — the same `extractYouTubeVideoId` desktop
 * routes through — so it needs no fetch and cannot be offered for a link it
 * would then fail to embed.
 */
export function pasteLinkOptions(url: string): PasteLinkOption[] {
  const options: PasteLinkOption[] = ['mention']
  if (extractYouTubeVideoId(url)) options.push('embed')
  options.push('bookmark', 'url')
  return options
}

const OPTION_LABEL: Record<PasteLinkOption, string> = {
  mention: 'Mention',
  embed: 'Embed video',
  bookmark: 'Bookmark',
  url: 'Keep as URL'
}

const OPTION_ICON: Record<PasteLinkOption, IconName> = {
  mention: 'link',
  embed: 'play',
  bookmark: 'bookmark',
  url: 'globe'
}

/** The two options whose block carries metadata worth fetching. */
export type PreviewOption = 'mention' | 'bookmark'

/**
 * The editor operations the menu needs, supplied by the caller.
 *
 * Not the editor itself, for the reason `WikiLinkEditorSurface` gives:
 * BlockNote's editor type is parameterised by the custom schema, so every one
 * of these calls has to be written where the schema is already in scope.
 */
export interface PasteLinkSurface {
  /** The block the caret is in once the paste has landed. */
  cursorBlockId(): string | null
  /**
   * Replace the pasted URL inside `blockId` with a link mention chip.
   *
   * `false` when the URL is no longer there — the document can move under a
   * menu that is waiting for a tap, and a mention written into a block that no
   * longer holds the link would be a chip the reader never asked for.
   */
  toMention(blockId: string, url: string): boolean
  /** Drop the pasted URL and insert a YouTube embed after `blockId`. */
  toEmbed(blockId: string, url: string, videoId: string): void
  /** Drop the pasted URL and insert a bookmark card after `blockId`. */
  toBookmark(blockId: string, url: string): void
  /** Write fetched metadata onto whichever node now carries `url`. */
  applyPreview(option: PreviewOption, url: string, preview: LinkPreview): void
}

export interface PasteLinkHosts {
  /** The mounted editor: where the paste is heard. */
  root: HTMLElement
  /** The viewport-pinned layer the toolbar and the wiki menu already draw in. */
  chrome: HTMLElement
  /** Measured, never written to — the toolbar's live top edge. */
  toolbarHost: HTMLElement
}

export interface PasteLinkMenu {
  close(): void
  detach(): void
}

interface OpenState {
  url: string
  blockId: string
}

export function installPasteLinkMenu(
  surface: PasteLinkSurface,
  bridge: GuestBridge,
  hosts: PasteLinkHosts
): PasteLinkMenu {
  const { root, chrome, toolbarHost } = hosts

  const menu = document.createElement('div')
  menu.className = 'paste-link-menu'
  menu.setAttribute('role', 'listbox')
  menu.setAttribute('aria-label', 'Paste link as')
  menu.hidden = true
  chrome.appendChild(menu)

  let state: OpenState | null = null
  let reqCounter = 0
  /** In-flight metadata requests, so a late answer knows what asked for it. */
  const pending = new Map<string, { option: PreviewOption; url: string }>()

  const close = (): void => {
    state = null
    menu.hidden = true
    menu.replaceChildren()
  }

  const requestPreview = (option: PreviewOption, url: string): void => {
    const reqId = `lp${++reqCounter}`
    pending.set(reqId, { option, url })
    bridge.send({ type: 'link-preview-req', reqId, url })
    // Flushed rather than batched: the card is on screen showing nothing but a
    // hostname until this round trip finishes.
    bridge.flush()
  }

  const choose = (option: PasteLinkOption): void => {
    const open = state
    if (!open) return
    const { url, blockId } = open
    // Closed FIRST: every branch below edits the document, and the `input`
    // listener that dismisses the menu would otherwise fire on the guest's own
    // edit and race the branch that made it.
    close()

    switch (option) {
      case 'url':
        return
      case 'mention':
        if (surface.toMention(blockId, url)) requestPreview('mention', url)
        return
      case 'embed': {
        const videoId = extractYouTubeVideoId(url)
        if (!videoId) return
        surface.toEmbed(blockId, url, videoId)
        return
      }
      case 'bookmark':
        surface.toBookmark(blockId, url)
        requestPreview('bookmark', url)
        return
      default: {
        const _exhaustive: never = option
        void _exhaustive
      }
    }
  }

  const open = (url: string, blockId: string): void => {
    state = { url, blockId }
    menu.replaceChildren()

    const heading = document.createElement('div')
    heading.className = 'paste-link-menu-title'
    heading.textContent = 'Paste as'
    menu.appendChild(heading)

    for (const option of pasteLinkOptions(url)) {
      menu.appendChild(optionRow(option, () => choose(option)))
    }

    // The same anchoring the wiki menu uses, and for the same reason: `chrome`
    // is pinned to the visible viewport but the toolbar's top edge moves with
    // the keyboard and the safe area, so it is measured rather than assumed.
    // The SHELL, not the host — the host div wrapping it is zero-high.
    const shell = toolbarHost.querySelector('.editor-toolbar-shell')
    const top = shell?.getBoundingClientRect().top
    menu.style.insetBlockEnd = top === undefined ? '' : `${Math.max(0, window.innerHeight - top)}px`
    menu.hidden = false
  }

  const onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData('text/plain')?.trim()
    if (!text || !URL_ONLY.test(text)) {
      close()
      return
    }
    // Deferred a frame, because the paste has not been inserted yet: the block
    // this menu will act on is the one the caret ends up in, and reading it
    // from inside the paste handler names the block the caret was in BEFORE.
    // `preventDefault` is deliberately never called — see the module comment.
    requestAnimationFrame(() => {
      const blockId = surface.cursorBlockId()
      if (!blockId) return
      open(text, blockId)
    })
  }

  const onInput = (): void => {
    if (state) close()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!state || event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  // Capture, so this runs before the rows' own `pointerdown`; a row inside the
  // menu is a choice and everything else is a dismissal.
  const onPointerDown = (event: Event): void => {
    if (!state) return
    const target = event.target
    if (target instanceof Node && menu.contains(target)) return
    close()
  }

  const unsubscribe = bridge.onHostMsg((msg) => {
    if (msg.type !== 'link-preview') return
    const request = pending.get(msg.reqId)
    if (!request) return
    pending.delete(msg.reqId)
    surface.applyPreview(request.option, request.url, msg)
  })

  root.addEventListener('paste', onPaste)
  root.addEventListener('input', onInput)
  root.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('pointerdown', onPointerDown, true)

  return {
    close,
    detach: () => {
      unsubscribe()
      root.removeEventListener('paste', onPaste)
      root.removeEventListener('input', onInput)
      root.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      pending.clear()
      menu.remove()
    }
  }
}

function optionRow(option: PasteLinkOption, onAccept: () => void): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'paste-link-item'
  row.setAttribute('role', 'option')
  row.setAttribute('data-option', option)

  const glyph = document.createElement('span')
  glyph.className = 'paste-link-glyph'
  glyph.appendChild(icon(OPTION_ICON[option]))
  row.appendChild(glyph)

  const label = document.createElement('span')
  label.className = 'paste-link-label'
  label.textContent = OPTION_LABEL[option]
  row.appendChild(label)

  row.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    onAccept()
  })
  return row
}

// ---------------------------------------------------------------------------
// Block content rewriting
// ---------------------------------------------------------------------------

interface InlineNode {
  type?: string
  text?: string
  href?: string
  props?: Record<string, unknown>
}

function asInlineNode(value: unknown): InlineNode | null {
  return typeof value === 'object' && value !== null ? (value as InlineNode) : null
}

/**
 * The node a paste left behind: BlockNote turns a bare URL into a `link` node,
 * and leaves it as text when it does not.
 */
export function isPastedUrl(node: unknown, url: string): boolean {
  const inline = asInlineNode(node)
  if (!inline) return false
  if (inline.type === 'link' && inline.href === url) return true
  return inline.type === 'text' && typeof inline.text === 'string' && inline.text.includes(url)
}

/** A finished mention chip pointing at `url`. */
export function isLinkMention(node: unknown, url: string): boolean {
  const inline = asInlineNode(node)
  return inline?.type === 'linkMention' && inline.props?.url === url
}

/** Drop the node at `index` — what "the URL becomes a block of its own" means. */
export function dropAt(inline: unknown[], index: number): unknown[] {
  return inline.filter((_, at) => at !== index)
}

/** Swap the node at `index` for `node`. */
export function replaceAt(inline: unknown[], index: number, node: unknown): unknown[] {
  const next = [...inline]
  next[index] = node
  return next
}

/**
 * Rewrite the first inline node in `content` that `match` accepts.
 *
 * A text block's content is a flat inline array, but a table block's is
 * `{ type: 'tableContent', rows: [{ cells: [...] }] }` with the inline content
 * one level down, per cell. `content.findIndex` throws on a table and spreading
 * it silently yields `[]`, which would wipe the table — so both shapes are
 * walked here and no caller touches `block.content` directly. Mirrors
 * desktop's `rewriteInlineContent`; the mobile schema has the same table block.
 *
 * `null` means nothing matched, which is distinct from "matched and produced an
 * empty block".
 *
 * The return is cast back to the caller's content type once, at the end: every
 * branch preserves the shape it was handed (array in, array out; `tableContent`
 * in, `tableContent` out), and typing that through BlockNote's schema-derived
 * content union is not writeable by hand.
 */
export function rewriteInlineContent<C>(
  content: C,
  match: (node: unknown) => boolean,
  rewrite: (inline: unknown[], index: number) => unknown[]
): C | null {
  if (Array.isArray(content)) {
    const index = content.findIndex(match)
    return index === -1 ? null : (rewrite(content, index) as C)
  }

  const table = content as { type?: string; rows?: unknown } | null
  if (table?.type !== 'tableContent' || !Array.isArray(table.rows)) return null

  let matched = false
  const rows = table.rows.map((row: unknown) => {
    const cells = (row as { cells?: unknown })?.cells
    if (matched || !Array.isArray(cells)) return row

    let rowMatched = false
    const nextCells = cells.map((cell: unknown) => {
      if (matched) return cell
      // A cell is a bare inline array in older documents and a `tableCell`
      // object with props in newer ones; both still have to round-trip.
      const cellContent = (cell as { content?: unknown })?.content
      const inline = Array.isArray(cell) ? cell : Array.isArray(cellContent) ? cellContent : null
      if (!inline) return cell

      const index = inline.findIndex(match)
      if (index === -1) return cell

      matched = true
      rowMatched = true
      const next = rewrite(inline, index)
      return Array.isArray(cell) ? next : { ...(cell as object), content: next }
    })

    return rowMatched ? { ...(row as object), cells: nextCells } : row
  })

  return matched ? ({ ...(table as object), rows } as C) : null
}
