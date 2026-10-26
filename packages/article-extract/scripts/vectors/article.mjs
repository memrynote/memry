/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types */
// Article vectors: the whole of `extractFromHtml` (node entry of Defuddle, async extractors on,
// markdown, then `mapToArticleCapture`) over a corpus page, with the page's recorded network
// responses replayed through Defuddle's `fetch` option.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { mapToArticleCapture } from '../../src/map.ts'
import { extractFromHtml } from '../../src/node.ts'
import { dist } from './probes.mjs'

const require = createRequire(join(dist, 'x.js'))
const { Defuddle } = require('./node.js')

const wellFormed = (v) => (typeof v === 'string' ? v.toWellFormed() : v)

/** `fetch.json`: `[{ method, url, body?, status, text } | { method, url, body?, error }]`. */
export function replayFetch(recorded) {
  const requests = []
  const fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase()
    const body = typeof init.body === 'string' ? init.body : null
    const headers = Object.entries(init.headers ?? {})
    requests.push({ method, url: String(url), headers, body })
    const hit = (recorded ?? []).find(
      (r) => r.method === method && r.url === String(url) && (r.body ?? null) === body
    )
    if (!hit) throw new Error(`no recorded response for ${method} ${url}`)
    if (hit.error) throw new TypeError(hit.error)
    return new Response(hit.text, { status: hit.status })
  }
  return { fetch, requests }
}

export async function articleVector({ name, html, url, now, fetch: recorded }) {
  const { fetch, requests } = replayFetch(recorded)
  const { document } = parseHTML(html)
  let result
  try {
    result = await Defuddle(document, url, { markdown: true, fetch })
  } catch (error) {
    // A page with no element at all: linkedom throws on `document.body`.
    return { input: { url, now, fetch: recorded }, error: error.constructor.name }
  }
  const unmatched = requests.filter(
    (r) => !(recorded ?? []).some((h) => h.method === r.method && h.url === r.url && (h.body ?? null) === r.body)
  )
  if (unmatched.length) {
    throw new Error(`${name}: requests without a recorded response: ${JSON.stringify(unmatched)}`)
  }
  const capture = JSON.parse(JSON.stringify(mapToArticleCapture(result, url, { now })))
  const raw = Object.fromEntries(
    ['title', 'author', 'published', 'description', 'image', 'site', 'language'].map((k) => [
      k,
      wellFormed(result[k] ?? '')
    ])
  )
  raw.wordCount = result.wordCount
  raw.schemaOrgData = wellFormed(JSON.stringify(result.schemaOrgData ?? null))
  raw.extractorType = result.extractorType ?? null
  if (!recorded) {
    const direct = JSON.parse(JSON.stringify(await extractFromHtml(html, url, { now })))
    if (JSON.stringify(direct) !== JSON.stringify(capture)) {
      throw new Error(`${name}: extractFromHtml differs from the generator composition`)
    }
  }
  return { input: { url, now, fetch: recorded }, expected: capture, raw, requests }
}
