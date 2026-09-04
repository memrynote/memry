/**
 * The glyph set the touch renderers draw with.
 *
 * Inline SVG rather than an icon package or a sprite file: `@memry/editor-web`
 * ships a fixed dependency list, and the WebView's CSP allows `img-src data:
 * blob:` only, so an icon that arrives as a file cannot load at all. Stroked in
 * `currentColor` so a glyph takes the colour of whatever chip or card it sits
 * in, which is what lets one `info` path serve four callout hues.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Path data by glyph name, in a 24x24 box. */
const ICON_PATHS = {
  info: ['M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0', 'M12 11v5', 'M12 8h.01'],
  warning: [
    'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.8-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    'M12 9v4',
    'M12 17h.01'
  ],
  error: ['M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0', 'm15 9-6 6', 'm9 9 6 6'],
  success: ['M22 12a10 10 0 1 1-20 0 10 10 0 1 1 20 0', 'm8.5 12.5 2.5 2.5 4.5-5.5'],
  file: ['M14.5 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6.5z', 'M14 2v5h5'],
  play: ['m7 4 12 8-12 8z'],
  link: [
    'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L11.7 5.2',
    'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'
  ],
  circle: ['M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0'],
  'check-circle': ['M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0', 'm8.5 12.5 2.5 2.5 4.5-5.5'],
  alarm: ['M20 13a8 8 0 1 1-16 0 8 8 0 1 1 16 0', 'M12 9.5V13l2 2', 'M5 3 2 6', 'm22 6-3-3']
} as const

export type IconName = keyof typeof ICON_PATHS

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '1em')
  svg.setAttribute('height', '1em')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.75')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')

  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}
