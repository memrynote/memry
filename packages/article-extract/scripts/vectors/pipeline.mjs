/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types */
// Pipeline vectors: the whole generic path of `Defuddle` (`parse()` with its retries, then
// `toMarkdown`, then `mapToArticleCapture`), the composition of `extractFromHtml`.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { mapToArticleCapture } from '../../src/map.ts'
import { Defuddle, dist } from './probes.mjs'

const require = createRequire(join(dist, 'x.js'))
const { createMarkdownContent } = require('./markdown.js')

const wellFormed = (v) => (typeof v === 'string' ? v.toWellFormed() : v)

export function pipelineVector(html, url, now) {
  const { document } = parseHTML(html)
  let result
  try {
    result = new Defuddle(document, { url: url || 'about:blank' }).parse()
  } catch (error) {
    // A page with no element at all: linkedom throws on `document.body`.
    return { input: { url, now }, error: error.constructor.name }
  }
  const content = wellFormed(result.content)
  const markdown = wellFormed(createMarkdownContent(content, url))
  const fields = ['title', 'author', 'published', 'description', 'image', 'site', 'language']
  const raw = Object.fromEntries(fields.map((k) => [k, wellFormed(result[k] ?? '')]))
  raw.wordCount = result.wordCount
  const capture = mapToArticleCapture({ ...result, content: markdown }, url, { now })
  return {
    input: { url, now },
    content,
    markdown,
    raw,
    expected: JSON.parse(JSON.stringify(capture))
  }
}
