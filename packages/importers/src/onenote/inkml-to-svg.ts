/**
 * Convert InkML (Ink Markup Language — OneNote handwriting/drawings) to SVG.
 *
 * Port of the obsidian-importer renderer, rebuilt on `fast-xml-parser` so it
 * stays pure (no DOMParser / jsdom): parse brush definitions, walk every
 * `<trace>`'s coordinate stream, compute the bounding box and emit one SVG
 * path (or dot) per trace with the brush's color/width/opacity.
 *
 * @module onenote/inkml-to-svg
 */

import { XMLParser } from 'fast-xml-parser'

/** Padding around the SVG content, in trace units. */
const PADDING = 10

interface BrushProperties {
  color: string
  width: number
  height: number
  transparency: number
}

interface TraceWithBrush {
  coords: number[][]
  brush: BrushProperties
}

const DEFAULT_BRUSH: BrushProperties = {
  color: '#000000',
  width: 70,
  height: 70,
  transparency: 0
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Brush transparency arrives either as a 0–1 fraction or, for highlighter
 * brushes, on OneNote's 0–255 byte scale. Treating a byte value as a fraction
 * yields a negative opacity, which SVG clamps to 0 — an invisible stroke.
 */
function normalizeTransparency(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value <= 1) return value
  return Math.min(value / 255, 1)
}

/**
 * Keep only characters that are valid inside an SVG colour attribute, so a
 * crafted brush colour cannot close the attribute and inject markup into the
 * generated file.
 */
function sanitizeColor(value: string): string {
  const cleaned = value.trim().replace(/[^#\w(),.%\s-]/g, '')
  return cleaned.length > 0 ? cleaned : DEFAULT_BRUSH.color
}

/**
 * Clean InkML content by removing any trailing MIME boundary markers after the
 * closing `</ink>` tag (the Graph multipart split can leave them behind).
 */
function cleanInkmlContent(inkmlContent: string): string {
  const closingTagMatch = inkmlContent.match(/<\/(?:[\w-]+:)?ink>/)
  if (closingTagMatch && closingTagMatch.index !== undefined) {
    return inkmlContent.substring(0, closingTagMatch.index + closingTagMatch[0].length)
  }
  return inkmlContent
}

type ParsedNode = Record<string, unknown>

/** Depth-first collect of every value under a given tag name. */
function collectByTag(node: unknown, tag: string, out: unknown[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectByTag(item, tag, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as ParsedNode)) {
    if (key === tag) {
      if (Array.isArray(value)) out.push(...value)
      else out.push(value)
    }
    // Attribute keys are plain strings; only objects/arrays can nest further.
    if (typeof value === 'object' && value !== null) collectByTag(value, tag, out)
  }
}

function attr(node: ParsedNode, name: string): string | null {
  const candidates = [`@_${name}`, `@_xml:${name}`, `@_inkml:${name}`]
  for (const key of candidates) {
    const value = node[key]
    if (typeof value === 'string' || typeof value === 'number') return String(value)
  }
  return null
}

function parseBrushes(root: unknown): Map<string, BrushProperties> {
  const brushMap = new Map<string, BrushProperties>()
  const brushNodes: unknown[] = []
  collectByTag(root, 'brush', brushNodes)

  for (const rawBrush of brushNodes) {
    if (rawBrush === null || typeof rawBrush !== 'object') continue
    const brushNode = rawBrush as ParsedNode
    const brushId = attr(brushNode, 'id')
    if (!brushId) continue

    const brush: BrushProperties = { ...DEFAULT_BRUSH }
    const props: unknown[] = []
    collectByTag(brushNode, 'brushProperty', props)
    for (const rawProp of props) {
      if (rawProp === null || typeof rawProp !== 'object') continue
      const propNode = rawProp as ParsedNode
      const name = attr(propNode, 'name')
      const value = attr(propNode, 'value')
      if (!name || value === null) continue
      switch (name) {
        case 'color':
          brush.color = sanitizeColor(value)
          break
        case 'width':
          brush.width = finiteOr(parseFloat(value), DEFAULT_BRUSH.width)
          break
        case 'height':
          brush.height = finiteOr(parseFloat(value), DEFAULT_BRUSH.height)
          break
        case 'transparency':
          brush.transparency = normalizeTransparency(parseFloat(value))
          break
      }
    }
    brushMap.set(brushId, brush)
  }

  return brushMap
}

function traceText(rawTrace: unknown): string {
  if (typeof rawTrace === 'string' || typeof rawTrace === 'number') return String(rawTrace)
  if (rawTrace === null || typeof rawTrace !== 'object') return ''
  const text = (rawTrace as ParsedNode)['#text']
  if (typeof text === 'string' || typeof text === 'number') return String(text)
  return ''
}

function parseCoords(text: string): number[][] {
  return (
    text
      .replace(/\n/g, '')
      .split(',')
      .map((coord) =>
        coord
          .trim()
          .split(' ')
          .filter((part) => part.length > 0)
          .map((axisCoord) => {
            const num = parseFloat(axisCoord)
            // Integers are already device units; floats are scaled for precision.
            return Number.isInteger(num) ? Math.round(num) : Math.round(num * 10000)
          })
      )
      // A trace with any unparseable token (delta-prefixed InkML) would poison
      // the bounding box into NaN and produce an unrenderable SVG.
      .filter((coord) => coord.length >= 2 && coord.every((axis) => Number.isFinite(axis)))
  )
}

function getTraces(root: unknown, brushMap: Map<string, BrushProperties>): TraceWithBrush[] {
  const traceNodes: unknown[] = []
  collectByTag(root, 'trace', traceNodes)

  const traces: TraceWithBrush[] = []
  for (const rawTrace of traceNodes) {
    const coords = parseCoords(traceText(rawTrace))
    if (coords.length === 0) continue

    let brush = DEFAULT_BRUSH
    if (rawTrace !== null && typeof rawTrace === 'object') {
      let brushRef = attr(rawTrace as ParsedNode, 'brushRef') ?? ''
      if (brushRef.startsWith('#')) brushRef = brushRef.substring(1)
      brush = brushMap.get(brushRef) ?? DEFAULT_BRUSH
    }

    traces.push({ coords, brush })
  }
  return traces
}

/**
 * Convert InkML content to an SVG string.
 *
 * @param inkmlContent - The raw InkML XML content as a string.
 * @returns SVG markup for the ink data, or null when there is nothing to draw
 *   (empty input, no traces, or unparseable XML).
 */
export function inkmlToSvg(inkmlContent: string): string | null {
  if (!inkmlContent || inkmlContent.trim().length === 0) return null

  let root: unknown
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      parseTagValue: false,
      parseAttributeValue: false
    })
    root = parser.parse(cleanInkmlContent(inkmlContent))
  } catch {
    return null
  }

  const traces = getTraces(root, parseBrushes(root))
  if (traces.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const trace of traces) {
    for (const coord of trace.coords) {
      minX = Math.min(minX, coord[0])
      minY = Math.min(minY, coord[1])
      maxX = Math.max(maxX, coord[0])
      maxY = Math.max(maxY, coord[1])
    }
  }

  const width = maxX - minX + PADDING * 2
  const height = maxY - minY + PADDING * 2

  const paths: string[] = []
  for (const trace of traces) {
    const stroke = trace.brush.color
    // Himetric-to-pixel conversion is skipped on purpose: 1:1 matches best.
    const strokeWidth = trace.brush.width
    const opacity = 1 - trace.brush.transparency
    const opacityAttr = opacity < 1 ? ` opacity="${opacity.toFixed(2)}"` : ''

    if (trace.coords.length === 1) {
      const x = trace.coords[0][0] - minX + PADDING
      const y = trace.coords[0][1] - minY + PADDING
      paths.push(
        `<circle cx="${x}" cy="${y}" r="${strokeWidth / 2}" fill="${stroke}"${opacityAttr}/>`
      )
    } else {
      const pathData = trace.coords
        .map((coord, index) => {
          const x = coord[0] - minX + PADDING
          const y = coord[1] - minY + PADDING
          return index === 0 ? `M ${x} ${y}` : `L ${x} ${y}`
        })
        .join(' ')
      paths.push(
        `<path d="${pathData}" stroke="${stroke}" stroke-width="${strokeWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"${opacityAttr}/>`
      )
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join('\n')}</svg>`
}
