/**
 * Parse a .enex (Evernote export) XML file into a list of {@link EnexNote}s.
 *
 * Uses fast-xml-parser for robust XML handling (CDATA, entity decode, etc.).
 *
 * ENEX structure:
 *   <en-export>
 *     <note>
 *       <title>…</title>
 *       <content><![CDATA[…ENML…]]></content>
 *       <created>YYYYMMDDTHHMMSSZ</created>
 *       <updated>YYYYMMDDTHHMMSSZ</updated>
 *       <tag>…</tag>           (0+, may repeat)
 *       <resource>
 *         <data encoding="base64">…</data>
 *         <mime>image/png</mime>
 *         <resource-attributes>
 *           <file-name>photo.png</file-name>
 *         </resource-attributes>
 *       </resource>            (0+)
 *     </note>
 *   </en-export>
 */

import { XMLParser } from 'fast-xml-parser'
import { parseEnexDate } from './dates.ts'
import type { EnexNote, EnexResource } from './types.ts'

const parser = new XMLParser({
  // Preserve CDATA — <content> is CDATA-wrapped ENML
  cdataPropName: '__cdata',
  // Don't coerce values to numbers/booleans
  parseTagValue: false,
  parseAttributeValue: false,
  // Keep attributes (e.g. encoding="base64")
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Allow multiple <note> and <tag> and <resource> siblings
  isArray: (_name, jpath) => {
    const leaf = jpath.split('.').pop() ?? ''
    return leaf === 'note' || leaf === 'tag' || leaf === 'resource'
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>

function extractContent(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') {
    const obj = raw as AnyObj
    if (typeof obj['__cdata'] === 'string') return obj['__cdata']
  }
  return ''
}

function extractTags(note: AnyObj): string[] {
  const raw = note['tag']
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string')
  if (typeof raw === 'string') return [raw]
  return []
}

function extractResources(note: AnyObj): EnexResource[] {
  const raw = note['resource']
  if (!raw) return []
  const list: AnyObj[] = Array.isArray(raw) ? raw : [raw]
  return list.map((r): EnexResource => {
    const dataNode = r['data']
    let rawBase64 = ''
    if (typeof dataNode === 'string') {
      rawBase64 = dataNode
    } else if (dataNode && typeof dataNode === 'object') {
      // When <data encoding="base64"> has attributes, fast-xml-parser wraps as
      // { "#text": "...", "@_encoding": "base64" } or { "__cdata": "..." }
      rawBase64 = String(dataNode['#text'] ?? dataNode['__cdata'] ?? '')
    }
    const base64 = rawBase64.replace(/\s+/g, '')
    const mime = typeof r['mime'] === 'string' ? r['mime'] : ''
    const attrs = r['resource-attributes'] as AnyObj | undefined
    const fileName =
      attrs && typeof attrs['file-name'] === 'string' ? attrs['file-name'] : undefined
    return { base64, mime, fileName }
  })
}

/**
 * Parse an Evernote .enex XML string and return one {@link EnexNote} per
 * `<note>` element found.
 */
export function parseEnex(xml: string): EnexNote[] {
  const root = parser.parse(xml) as AnyObj
  const exportNode = root['en-export'] as AnyObj | undefined
  if (!exportNode) return []

  const notes: AnyObj[] = Array.isArray(exportNode['note'])
    ? exportNode['note']
    : exportNode['note']
      ? [exportNode['note']]
      : []

  return notes.map((note): EnexNote => {
    const title = typeof note['title'] === 'string' ? note['title'].trim() : 'Untitled'
    const contentHtml = extractContent(note['content'])
    const created = parseEnexDate(note['created'])
    const updated = parseEnexDate(note['updated'])
    const tags = extractTags(note)
    const resources = extractResources(note)
    return { title, contentHtml, created, updated, tags, resources }
  })
}
