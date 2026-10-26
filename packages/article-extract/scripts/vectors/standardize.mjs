/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types */
// Standardize vectors: the content element after `standardizeFootnotes`, `standardizeCallouts`
// and `standardizeContent` (dist/defuddle.js:858-909), in two variants. `direct` runs them on the
// element the content finder picks; `pipeline` runs the metadata block, the footnotes, the
// callouts and the five removal steps of the default run first, as `parseInternal` orders them.
//
// `standardizeElements` renders LaTeX to MathML through temml, which the next stage ports. Until
// then temml throws here, as a failing converter does in Defuddle (the LaTeX stays as text);
// `withDeferredRulesOff` is the patch to delete.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { dist } from './probes.mjs'
import { preparePage, removalSteps, removeMetadataBlockStep } from './removals.mjs'

const require = createRequire(join(dist, 'x.js'))
const callouts = require('./elements/callouts.js')
const footnotes = require('./elements/footnotes.js')
const temml = require('temml')
const standardize = require('./standardize.js')

export const standardizeVariants = ['direct', 'pipeline']
export { URL as standardizeUrl } from './removal-pages.mjs'
const wellFormed = (value) => (typeof value === 'string' ? value.toWellFormed() : value)

/** Runs `run` with temml throwing, as a failing converter does in Defuddle: LaTeX stays as text. */
const fail = () => {
  throw new Error('deferred converter')
}

export function withDeferredRulesOff(run) {
  const patches = [[temml, 'renderToString']].map(([target, key]) => [
    target,
    key,
    Object.getOwnPropertyDescriptor(target, key)
  ])
  for (const [target, key] of patches) Object.defineProperty(target, key, { value: fail })
  try {
    return run()
  } finally {
    for (const [target, key, descriptor] of patches) Object.defineProperty(target, key, descriptor)
  }
}

function runVariant(html, url, variant) {
  const { options, metadata, small, clone, main, input, document } = preparePage(html, url)
  input.variant = variant
  if (!main) return { input, steps: null, main: null }
  const steps = {}
  let last = wellFormed(main.outerHTML)
  const step = (key, run) => {
    run()
    const now = wellFormed(main.outerHTML)
    steps[key] = now === last ? null : now
    last = now
  }
  if (variant === 'pipeline') {
    step('metadataBlock', () => removeMetadataBlockStep(main, input.hasPublishedOrAuthor))
  }
  step('footnotes', () => footnotes.standardizeFootnotes(main))
  step('callouts', () => callouts.standardizeCallouts(main))
  if (variant === 'pipeline') {
    const state = { clone, main, small, url, metadata }
    for (const [key, run] of removalSteps) step(key, () => run(state, options))
  }
  step('standardize', () =>
    withDeferredRulesOff(() => standardize.standardizeContent(main, metadata, document, false))
  )
  return { input, steps, main }
}

export function standardizeVector(html, url, variant) {
  const { input, steps } = runVariant(html, url, variant)
  return { input, steps }
}

/** The content HTML `parseInternal` hands to `toMarkdown` (the `pipeline` variant's element), or
 *  null when the content finder finds nothing. */
export function standardizedContent(html, url) {
  const { main } = runVariant(html, url, 'pipeline')
  return main ? wellFormed(main.outerHTML) : null
}

/** Both variants of one page. */
export const standardizeVectors = (html, url) =>
  Object.fromEntries(standardizeVariants.map((v) => [v, standardizeVector(html, url, v)]))
