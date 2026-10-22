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
 * The `portal_refs` rows for a note body. A fence this build cannot read keeps
 * its ordinal but gets no row, so ordinals stay stable across edits elsewhere.
 */
export function derivePortalRefs(hostNoteId: string, markdown: string): PortalRefRow[] {
  const rows: PortalRefRow[] = []
  scanPortalFences(markdown).forEach((body, ordinal) => {
    const parsed = parsePortalDefinition(body)
    if (!parsed.ok) return
    const { target, hidden } = parsed.definition
    rows.push({
      hostNoteId,
      ordinal,
      sourceNoteId: target.kind === 'search' ? null : target.note,
      anchor: target.kind === 'block' ? target.block : null,
      hiddenCount: hidden.length,
      kind: target.kind
    })
  })
  return rows
}
