import { getTagColors, TAG_CHIP_FILL_ALPHA, withAlpha } from '@memry/contracts/tag-colors'
import {
  createDateMentionSpec,
  createHashTagSpec,
  createInlineCheckboxContent,
  createInlineCheckboxDOM,
  createInlineCheckboxSpec,
  createInlineImageSpec,
  createLinkMentionSpec,
  toChecked,
  toWidth,
  WikiLink,
  type MemryInlineSpecs
} from '@memry/editor-schema/inline'
import { icon } from './icons.ts'

/**
 * Touch presentation for Memry's inline content.
 *
 * Config, `parse` and `toExternalHTML` all come from `@memry/editor-schema`
 * untouched, so `#tag`, `((date:…))`, `((mention:…))`, `![alt](src)` and
 * `[ ] ` reach the vault byte-for-byte as they do from desktop and from the
 * main process. Only `render` is supplied here.
 *
 * Two constraints shape every chip below. The WebView's CSP is
 * `img-src data: blob:`, so a remote favicon is never an `src`: it is parked on
 * `data-asset-ref` and `images.ts` has the host fetch the bytes and hand back a
 * data URI. Nor may anything navigate: a chip that carries an external URL
 * exposes it as `data-url`, and `external-links.ts` routes the tap over the
 * bridge for the host to hand to the OS.
 */

/** An icon prop that is an emoji rather than a name in desktop's icon registry. */
const ICON_NAME = /^[A-Za-z0-9._-]+$/

function span(className: string, text?: string): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

/**
 * An `<img>` with no `src`, only the reference `images.ts` claims.
 *
 * Setting `src` to the remote URL first would flash the broken-image glyph and
 * spend a blocked request under `img-src data: blob:` before the resolver could
 * strip it.
 */
function assetImage(className: string, ref: string): HTMLImageElement {
  const element = document.createElement('img')
  element.className = className
  element.alt = ''
  element.setAttribute('data-asset-ref', ref)
  return element
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * The text a date pill shows.
 *
 * Desktop also has a `This/Next/Last <Weekday>` tier. It is left out rather
 * than approximated: that tier reads the user's week-start preference, and the
 * `cfg` message the host sends this WebView carries theme, locale, direction,
 * reduced motion and read-only — not week start. Guessing Monday would print a
 * different day name on the phone than on the desktop for the same date.
 */
export function dateMentionLabel(props: {
  dateISO: string
  hasTime: boolean
  dateFormat: string
  timeFormat: string
}): string {
  const date = props.dateISO ? new Date(props.dateISO) : null
  if (!date || Number.isNaN(date.getTime())) return 'Date'

  const full = `${date.getDate()} ${date.toLocaleDateString(undefined, { month: 'short' })}, ${date.getFullYear()}`
  let label = full
  if (props.dateFormat !== 'full') {
    const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000)
    if (days === 0) label = 'Today'
    else if (days === 1) label = 'Tomorrow'
    else if (days === -1) label = 'Yesterday'
  }

  if (!props.hasTime) return label

  const hour12 = props.timeFormat === '12h' ? true : props.timeFormat === '24h' ? false : undefined
  return `${label} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12 })}`
}

export function createTouchInlineSpecs(): MemryInlineSpecs {
  return {
    hashTag: createHashTagSpec((inlineContent) => {
      const { tag, color, icon: iconProp } = inlineContent.props
      const colors = getTagColors(color, tag)

      const dom = span('hash-tag', `#${tag}`)
      dom.setAttribute('data-hash-tag', tag)
      dom.setAttribute('contenteditable', 'false')
      dom.style.setProperty('--hash-tag-color', colors.text)
      dom.style.backgroundColor = withAlpha(colors.text, TAG_CHIP_FILL_ALPHA)

      // An icon-name value addresses desktop's HugeIcon registry, which this
      // bundle does not carry; an emoji is just text and can be shown as-is.
      if (iconProp && !ICON_NAME.test(iconProp)) {
        const glyph = span('hash-tag-icon', iconProp)
        glyph.setAttribute('aria-hidden', 'true')
        dom.prepend(glyph)
      }

      return { dom }
    }),

    dateMention: createDateMentionSpec((inlineContent) => {
      const { anchorId, dateISO, hasTime, dateFormat, remind, timeFormat } = inlineContent.props

      const dom = span('date-mention')
      dom.setAttribute('data-date-mention', '')
      dom.setAttribute('data-anchor-id', anchorId)
      dom.setAttribute('data-date-iso', dateISO)
      dom.setAttribute('data-has-time', String(hasTime))
      dom.setAttribute('data-remind', remind)
      dom.setAttribute('contenteditable', 'false')
      dom.setAttribute('role', 'button')

      const at = span('date-mention-at', '@')
      at.setAttribute('aria-hidden', 'true')
      dom.append(
        at,
        span('date-mention-label', dateMentionLabel({ dateISO, hasTime, dateFormat, timeFormat }))
      )

      if (remind && remind !== 'none') {
        const bell = span('date-mention-icon')
        bell.appendChild(icon('alarm'))
        dom.appendChild(bell)
      }

      return { dom }
    }),

    inlineImage: createInlineImageSpec((inlineContent) => {
      const dom = span('inline-image-wrap')
      dom.setAttribute('contenteditable', 'false')

      const img = document.createElement('img')
      img.className = 'inline-image'
      // Written raw and vault-relative. `images.ts` swaps in the bytes at the
      // DOM level, so the document keeps the reference the file on disk holds.
      img.setAttribute('src', inlineContent.props.src || '')
      img.setAttribute('alt', inlineContent.props.alt || '')
      const width = toWidth(inlineContent.props.width)
      if (width > 0) img.style.inlineSize = `${width}px`

      dom.appendChild(img)
      // No resize grip: it is a hover affordance, and there is no hover here.
      return { dom }
    }),

    inlineCheckbox: createInlineCheckboxSpec((inlineContent, updateInlineContent) => {
      const checked = toChecked(inlineContent.props.checked)
      const dom = createInlineCheckboxDOM(checked)
      dom.setAttribute('contenteditable', 'false')

      const swallow = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      const onPointerUp = (event: Event): void => {
        event.preventDefault()
        // The DOCUMENT is the truth. Reading the input's own `checked` back
        // would tick from whatever the browser already did to the element,
        // which is not necessarily what the note says.
        updateInlineContent(createInlineCheckboxContent(!checked))
      }
      dom.addEventListener('mousedown', swallow)
      dom.addEventListener('click', swallow)
      dom.addEventListener('pointerup', onPointerUp)

      return {
        dom,
        destroy: () => {
          dom.removeEventListener('mousedown', swallow)
          dom.removeEventListener('click', swallow)
          dom.removeEventListener('pointerup', onPointerUp)
        }
      }
    }),

    linkMention: createLinkMentionSpec((inlineContent) => {
      const { url, domain, title, favicon, siteName } = inlineContent.props
      let hostname = ''
      try {
        hostname = new URL(url).hostname.replace(/^www\./, '')
      } catch {
        hostname = ''
      }

      // A `<span>` rather than the shared `LinkMention` spec's `<a>`: the host
      // refuses every WebView navigation, so an `<a href>` would be a dead
      // chip, and `data-url` below is what makes it tappable instead. The
      // favicon IS drawn, as a `data-asset-ref` the host proxies into a data
      // URI — the CSP still forbids loading that remote URL directly.
      const dom = span('link-mention')
      dom.setAttribute('data-link-mention', '')
      dom.setAttribute('data-url', url)
      dom.setAttribute('data-domain', domain)
      dom.setAttribute('data-title', title)
      // Read back by the shared spec's `parse`, so the round trip stays
      // symmetric even though this side never reads it.
      dom.setAttribute('data-favicon', favicon)
      dom.setAttribute('data-site-name', siteName)
      dom.setAttribute('contenteditable', 'false')

      if (favicon) dom.appendChild(assetImage('link-mention-favicon', favicon))
      dom.appendChild(span('link-mention-site', siteName || domain || hostname || url))
      if (title) dom.appendChild(span('link-mention-title', title))

      return { dom }
    }),

    wikiLink: WikiLink
  }
}
