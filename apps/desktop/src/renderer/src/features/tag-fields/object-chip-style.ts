import { loadAllIcons } from '@/lib/hugeicon-renderer'
import { isIconValue, parseIconName } from '@/components/note/note-title/emoji-icon-utils'
import { objectColor, objectInitials, type ObjectLook } from './object-avatar'

const DEFAULT_ICON = 'Tag01Icon'
const SVG_NS = 'http://www.w3.org/2000/svg'

const markups = new Map<string, string | null>()

function iconName(icon: string | null): string | null {
  if (icon === null) return DEFAULT_ICON
  return isIconValue(icon) ? parseIconName(icon) : null
}

function toMarkup(data: Array<[string, Record<string, string>]>): string {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('xmlns', SVG_NS)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  for (const [tag, attrs] of data) {
    const el = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
    svg.appendChild(el)
  }
  return new XMLSerializer().serializeToString(svg)
}

function iconImage(markup: string, color: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(markup.replaceAll('currentColor', color))}")`
}

export async function loadChipIcons(icons: ReadonlyArray<string | null>): Promise<boolean> {
  const wanted = [...new Set(icons.map(iconName))].filter(
    (name): name is string => name !== null && !markups.has(name)
  )
  if (wanted.length === 0) return false
  const all = await loadAllIcons()
  for (const name of wanted) {
    const data = all[name] as Array<[string, Record<string, string>]> | undefined
    markups.set(name, data ? toMarkup(data) : null)
  }
  return true
}

export function objectChipAttrs(look: ObjectLook, title: string): Record<string, string> {
  const color = objectColor(look)
  const attrs: Record<string, string> = {
    class: 'wiki-link--object',
    'data-object-tag': look.tag
  }
  let style = `--object-color:${color};`
  if (look.avatar) {
    attrs['data-object-initials'] = objectInitials(title)
  } else {
    const name = iconName(look.icon)
    const markup = name ? markups.get(name) : null
    if (markup) style += `--object-icon:${iconImage(markup, color)};`
    else if (look.icon && !isIconValue(look.icon) && !look.icon.startsWith('custom:'))
      attrs['data-object-emoji'] = look.icon
    attrs['data-object-tile'] = ''
  }
  attrs.style = style
  return attrs
}
