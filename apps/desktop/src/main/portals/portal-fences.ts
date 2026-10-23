import { PORTAL_BLOCK_LANGUAGE, parsePortalDefinition } from '@memry/shared/portal-block'
import type { PortalRefRow } from '@main/database/queries/notes'

const FENCE_OPEN = /^[\s>]*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/

/**
 * The body of every `memry-portal` fence in a markdown note, in document order.
 * Fences of any other language are skipped whole, so a portal fence quoted
 * inside a ```` ```markdown ```` example is not a portal.
 */
export function scanPortalFences(markdown: string): string[] {
  const bodies: string[] = []
  const lines = markdown.split(/\r?\n/)
  let open: { marker: string; language: string; body: string[] } | null = null

  for (const line of lines) {
    if (open === null) {
      const match = FENCE_OPEN.exec(line)
      if (match) open = { marker: match[1], language: match[2], body: [] }
      continue
    }
    const stripped = line.replace(/^[\s>]*/, '')
    const isClose =
      stripped.startsWith(open.marker[0].repeat(open.marker.length)) &&
      stripped.replace(new RegExp(`^\\${open.marker[0]}+`), '').trim() === ''
    if (isClose) {
      if (open.language === PORTAL_BLOCK_LANGUAGE) bodies.push(open.body.join('\n'))
      open = null
    } else {
      open.body.push(line.replace(/^[\s>]*/, ''))
    }
  }
  // An unclosed fence runs to the end of the document, as in CommonMark.
  if (open?.language === PORTAL_BLOCK_LANGUAGE) bodies.push(open.body.join('\n'))
  return bodies
}

/**
 * The `portal_refs` rows for a note body: one per root anchor and per shown
 * child of a blocks portal, one for a note or search portal. A fence this build cannot read
 * keeps its ordinal but gets no row, so ordinals stay stable across edits
 * elsewhere.
 */
export function derivePortalRefs(hostNoteId: string, markdown: string): PortalRefRow[] {
  const rows: PortalRefRow[] = []
  scanPortalFences(markdown).forEach((body, ordinal) => {
    const parsed = parsePortalDefinition(body)
    if (!parsed.ok) return
    const { target } = parsed.definition
    if (target.kind === 'blocks') {
      // A block a portal lists as shown is on screen in that host as much as a root is,
      // so deleting it must find the host. Hide lists are exclusions and add nothing.
      const shown = Object.values(target.open).flatMap((entry) =>
        entry.mode === 'show' ? entry.ids : []
      )
      const anchors = [...new Set([...target.blocks, ...shown])]
      anchors.forEach((anchor, root) => {
        rows.push({ hostNoteId, ordinal, root, sourceNoteId: target.note, anchor, kind: 'blocks' })
      })
      return
    }
    rows.push({
      hostNoteId,
      ordinal,
      root: 0,
      sourceNoteId: target.kind === 'note' ? target.note : null,
      anchor: null,
      kind: target.kind
    })
  })
  return rows
}
