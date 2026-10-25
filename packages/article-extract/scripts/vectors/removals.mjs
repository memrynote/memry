/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types */
// Removal vectors: the content element and the clone after each removal step of
// `Defuddle.parseInternal` (dist/defuddle.js:843-905), run on the pristine page. The steps in
// between that belong to later ports (footnotes, callouts, standardize) are not run.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { Defuddle, MetadataExtractor, dist } from './probes.mjs'

const require = createRequire(join(dist, 'x.js'))
const smallImages = require('./removals/small-images.js')
const hidden = require('./removals/hidden.js')
const selectors = require('./removals/selectors.js')
const metadataBlock = require('./removals/metadata-block.js')
const contentPatterns = require('./removals/content-patterns.js')
const { ContentScorer } = require('./removals/scoring.js')

/** The options `parseInternal` starts from, then what each variant changes (the retries and the
 *  extractor pipeline run with these). */
const defaults = {
  removeExactSelectors: true,
  removePartialSelectors: true,
  removeHiddenElements: true,
  removeLowScoring: true,
  removeSmallImages: true,
  removeContentPatterns: true
}
export const variants = [
  { name: 'default', options: {} },
  { name: 'keep-hidden', options: { removeHiddenElements: false } },
  { name: 'extractor', options: { removeLowScoring: false, removeHiddenElements: false } },
  {
    name: 'gates-off',
    options: {
      removeExactSelectors: false,
      removeSmallImages: false,
      removeContentPatterns: false
    }
  },
  { name: 'partial-off', options: { removePartialSelectors: false, removeLowScoring: false } }
]

const wellFormed = (value) => (typeof value === 'string' ? value.toWellFormed() : value)
const ELEMENT = 1

/** Child indices from `root` to `node`. */
function pathTo(root, node) {
  const path = []
  for (let cur = node; cur !== root; cur = cur.parentNode) {
    path.unshift([...cur.parentNode.childNodes].indexOf(cur))
  }
  return path
}

/** What the vector holds of the state: the content element and the size of the clone. */
function snapshot(clone, main) {
  return { main: wellFormed(main.outerHTML), cloneLength: clone.documentElement.outerHTML.length }
}

export function removalsVector(html, url, name = 'default') {
  const variant = variants.find((v) => v.name === name)
  const options = { ...defaults, ...variant.options }
  const { document } = parseHTML(html)
  const defuddle = new Defuddle(document, { url })
  const schemaOrgData = defuddle.getSchemaOrgData()
  const metaTags = defuddle._collectMetaTags()
  const metadata = MetadataExtractor.extract(document, schemaOrgData, metaTags)
  const small = smallImages.findSmallImages(document, false)
  const clone = document.cloneNode(true)
  clone.body?.normalize()
  let main = defuddle.findMainContent(clone)
  if (main?.tagName.toLowerCase() === 'body') {
    const schemaText = defuddle._getSchemaText(schemaOrgData)
    const found = schemaText ? defuddle._findElementBySchemaText(clone.body, schemaText) : null
    if (found) main = found
  }
  const input = {
    url,
    title: wellFormed(metadata.title || ''),
    description: wellFormed(metadata.description || ''),
    hasPublishedOrAuthor: Boolean(metadata.published || metadata.author),
    options: variant.options,
    smallImages: [...small].map(wellFormed)
  }
  if (!main) return { input, main: null }
  input.mainPath = pathTo(clone, main)

  const steps = {}
  let last = snapshot(clone, main)
  steps.initial = last
  const step = (key, run) => {
    run()
    const now = snapshot(clone, main)
    steps[key] = { main: now.main === last.main ? null : now.main, cloneLength: now.cloneLength }
    last = now
  }
  step('metadataBlock', () => {
    if (input.hasPublishedOrAuthor) metadataBlock.removeMetadataBlock(main)
    for (const el of main.querySelectorAll('wbr')) el.remove()
  })
  step('smallImages', () => {
    if (options.removeSmallImages) smallImages.removeSmallImages(clone, small, false)
  })
  step('hidden', () => {
    if (options.removeHiddenElements) hidden.removeHiddenElements(clone, false, [])
  })
  step('eyebrow', () => {
    if (options.removeContentPatterns) contentPatterns.removeEyebrowLabel(main, false, [])
  })
  step('selectors', () => {
    if (options.removeExactSelectors || options.removePartialSelectors) {
      selectors.removeBySelector(
        clone,
        false,
        options.removeExactSelectors,
        options.removePartialSelectors,
        main,
        [],
        options.removeHiddenElements === false
      )
    }
  })
  step('lowScoring', () => {
    if (options.removeLowScoring) ContentScorer.scoreAndRemove(clone, false, [], main)
  })
  step('contentPatterns', () => {
    if (options.removeContentPatterns) {
      contentPatterns.removeByContentPattern(
        main,
        false,
        url,
        metadata.title || '',
        metadata.description || '',
        []
      )
    }
  })
  return { input, steps }
}

/** `ContentScorer.scoreElement` for every element of the page: the number the content search
 *  (stage 2e) ranks candidates by. */
export function scoreVector(html) {
  const { document } = parseHTML(html)
  const out = []
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === ELEMENT) {
        out.push(String(ContentScorer.scoreElement(child)))
        visit(child)
      }
    }
  }
  visit(document)
  return out
}

/** Every variant of one page. */
export function removalsVectors(html, url) {
  return Object.fromEntries(variants.map((v) => [v.name, removalsVector(html, url, v.name)]))
}
