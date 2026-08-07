/**
 * Split a Graph `/pages/{id}/content?includeInkML=true` response into its
 * `text/html` and `application/inkml+xml` parts.
 *
 * The response is a MIME multipart document whose boundary is the first line.
 * A response without a boundary (plain HTML — how the endpoint answers when
 * InkML is not requested or the page has no ink) passes through as html.
 *
 * @module onenote/multipart
 */

import type { OneNotePageContentParts } from './types.ts'

/** Split one MIME part into headers and body (separated by the first blank line). */
function partBody(part: string): { contentType: string | null; body: string } {
  const normalized = part.replace(/\r\n/g, '\n')
  const headerEnd = normalized.indexOf('\n\n')
  const headers = headerEnd === -1 ? normalized : normalized.slice(0, headerEnd)
  const body = headerEnd === -1 ? '' : normalized.slice(headerEnd + 2)

  const contentTypeLine = headers
    .split('\n')
    .find((line) => line.toLowerCase().startsWith('content-type'))
  const contentType = contentTypeLine
    ? (contentTypeLine.split(':')[1] ?? '').split(';')[0].trim().toLowerCase()
    : null

  return { contentType, body: body.trim() }
}

/**
 * Split page content into HTML + InkML.
 *
 * @param input - Raw response body from the page content endpoint.
 * @returns The `text/html` part and the `application/inkml+xml` part (empty
 *   string when the page has no ink or the response was plain HTML).
 */
export function splitPageContent(input: string): OneNotePageContentParts {
  const firstLine = input.split(/\r?\n/, 1)[0]?.trim() ?? ''

  // Plain HTML response (no multipart wrapper).
  if (!firstLine.startsWith('--')) {
    return { html: input, inkml: '' }
  }

  const boundary = firstLine
  const out: OneNotePageContentParts = { html: '', inkml: '' }

  for (const rawPart of input.split(boundary)) {
    const trimmed = rawPart.trim()
    if (!trimmed || trimmed === '--') continue

    const { contentType, body } = partBody(rawPart)
    if (contentType === 'text/html') out.html = body
    else if (contentType === 'application/inkml+xml') out.inkml = body
  }

  // A multipart wrapper with no recognizable html part: keep the raw input so
  // the caller still has something to convert rather than an empty note.
  if (!out.html && !out.inkml) {
    return { html: input, inkml: '' }
  }

  return out
}
