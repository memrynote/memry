/**
 * The row and card a wiki link draws as when it is alone on its line (#2845).
 *
 * The node and its chip are `@memry/editor-schema`'s. This wraps the chip's
 * render and adds the elements a row or card needs, and only for a link whose
 * display settings ask for them, so every other link keeps the DOM it always
 * had. The elements are always there for a configured link and CSS shows them
 * only where `wiki-link-card-plugin.ts` marked the link as alone in its
 * paragraph: a link inside running text stays a chip whatever its props say.
 */

import {
  createWikiLinkSpec,
  renderWikiLink,
  type WikiLinkRender
} from '@memry/editor-schema/inline'
import { wikiLinkDisplayProps } from '@memry/shared/wiki-link-props'
import { toWebviewUrl } from '@/lib/memry-file-url'
import type { WikiLinkCardContent } from './wiki-link-card-content'
import { hydrateWikiLinkCard } from './wiki-link-card-data'

// Lucide `file-text`, as markup because this is raw DOM with no React icon.
const FILE_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/><path d="M16 13h-2"/></svg>'

function span(className: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = className
  return el
}

/** Puts the content of the linked note into the card elements of one chip. */
export function fillWikiLinkCard(chip: HTMLElement, content: WikiLinkCardContent | null): void {
  const icon = chip.querySelector<HTMLElement>('.wiki-link-card-icon')
  if (icon) {
    if (content?.icon) icon.textContent = content.icon
    else icon.innerHTML = FILE_ICON_SVG
    icon.toggleAttribute('data-emoji', Boolean(content?.icon))
  }

  const preview = chip.querySelector<HTMLElement>('.wiki-link-card-preview')
  if (preview) preview.textContent = content?.text ?? ''

  const cover = chip.querySelector<HTMLElement>('.wiki-link-card-cover')
  if (!cover) return
  cover.replaceChildren()
  cover.style.backgroundImage = ''
  if (content?.cover?.kind === 'wash') {
    cover.style.backgroundImage = content.cover.gradient
  } else if (content?.cover) {
    const image = document.createElement('img')
    image.alt = ''
    image.loading = 'lazy'
    // A cover that will not load leaves the card without one, not a broken image.
    image.addEventListener('error', () => image.remove())
    image.src = toWebviewUrl(content.cover.url)
    cover.append(image)
  }
}

export const renderWikiLinkWithCard: WikiLinkRender = (inlineContent) => {
  const rendered = renderWikiLink(inlineContent)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inline content props are typed per spec; the display helper reads them as a bag
  const display = wikiLinkDisplayProps(inlineContent.props as Record<string, unknown>)
  if (display.size === 'none' && !display.preview) return rendered

  const chip = rendered.dom
  const card = display.size !== 'none'

  const title = span('wiki-link-card-title')
  title.append(...chip.childNodes)
  const text = span('wiki-link-card-text')
  text.append(title)
  if (display.preview) text.append(span('wiki-link-card-preview'))

  chip.setAttribute('data-wiki-link-card', '')
  if (card) {
    const icon = span('wiki-link-card-icon')
    icon.innerHTML = FILE_ICON_SVG
    chip.append(icon)
  }
  chip.append(text)
  if (card && display.cover) chip.append(span('wiki-link-card-cover'))

  void hydrateWikiLinkCard(chip, fillWikiLinkCard)
  // The content arrives after the node is built; ProseMirror must not read the
  // elements filling in as an edit to the document.
  return { dom: chip, ignoreMutation: () => true }
}

export const WikiLinkWithCard = createWikiLinkSpec(renderWikiLinkWithCard)
