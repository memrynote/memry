/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types */
// Metadata vectors: what Defuddle 0.19.0 collects from a page before it changes anything:
// meta tags, JSON-LD, `MetadataExtractor.extract`, the schema text and the content boundary.
import { parseHTML } from 'linkedom'
import { Defuddle, MetadataExtractor, contentBoundary } from './probes.mjs'

const ELEMENT = 1

function elementsOf(root) {
  const out = []
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === ELEMENT) {
        out.push(child)
        visit(child)
      }
    }
  }
  visit(root)
  return out
}

const wellFormed = (value) => (typeof value === 'string' ? value.toWellFormed() : value)

export function metadataVector(html) {
  const { document } = parseHTML(html)
  const defuddle = new Defuddle(document, { url: 'https://example.com/page' })
  const metaTags = defuddle._collectMetaTags()
  const schemaOrgData = defuddle.getSchemaOrgData()
  const metadata = MetadataExtractor.extract(document, schemaOrgData, metaTags)
  // A document without an element makes `document.body` throw; nothing can run on it then.
  let body = null
  try {
    body = document.body
  } catch {
    body = null
  }
  const elements = elementsOf(document)
  const ordinal = (el) => (el ? elements.indexOf(el) : null)
  const firstHeading = document.querySelector('h1')?.textContent ?? ''

  const find = (title) => (body ? contentBoundary.findContentStart(body, title) : null)
  const start = find(metadata.title)
  const startNoTitle = find('')
  const startHeading = find(firstHeading)
  return {
    metaTags: metaTags.map((tag) => ({
      name: tag.name,
      property: tag.property,
      content: wellFormed(tag.content)
    })),
    schemaOrgData: JSON.stringify(schemaOrgData).toWellFormed(),
    schemaText: wellFormed(defuddle._getSchemaText(schemaOrgData)),
    metadata: Object.fromEntries(
      [
        'title',
        'description',
        'domain',
        'favicon',
        'image',
        'language',
        'published',
        'author',
        'site'
      ].map((key) => [key, wellFormed(metadata[key])])
    ),
    contentStart: ordinal(start),
    contentStartNoTitle: ordinal(startNoTitle),
    contentStartHeading: ordinal(startHeading),
    above: elements
      .map((el) => (contentBoundary.isAboveContentStart(el, start) ? '1' : '0'))
      .join('')
  }
}
