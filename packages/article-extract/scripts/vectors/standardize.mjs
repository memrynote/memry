/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types */
// Standardize vectors: the content element after `standardizeFootnotes`, `standardizeCallouts`
// and `standardizeContent` (dist/defuddle.js:858-909), in two variants. `direct` runs them on the
// element the content finder picks; `pipeline` runs the metadata block, the footnotes, the
// callouts and the five removal steps of the default run first, as `parseInternal` orders them.
//
// `standardizeElements` also converts math with rules that stage 4 ports with its elements.
// Until then those rules are switched off here; `withDeferredRulesOff` is the patch to delete.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { dist } from './probes.mjs'
import { preparePage, removalSteps, removeMetadataBlockStep } from './removals.mjs'

const require = createRequire(join(dist, 'x.js'))
const callouts = require('./elements/callouts.js')
const footnotes = require('./elements/footnotes.js')
const math = require('./elements/math.js')
const mathBase = require('./elements/math.base.js')
const standardize = require('./standardize.js')

export const standardizeVariants = ['direct', 'pipeline']
export { URL as standardizeUrl } from './removal-pages.mjs'
const wellFormed = (value) => (typeof value === 'string' ? value.toWellFormed() : value)

/** Runs `run` with the math rules of stage 4 switched off:
 *  their selectors match nothing, the LaTeX wrapper does nothing and no `img` looks like LaTeX. */
export function withDeferredRulesOff(run) {
  const rules = [...math.mathRules]
  const saved = rules.map((rule) => rule.selector)
  const { wrapRawLatexDelimiters, extractLatexFromImageSrc, LOOKS_LIKE_LATEX_RE } = mathBase
  for (const rule of rules) rule.selector = 'deferred-rule'
  mathBase.wrapRawLatexDelimiters = () => {}
  mathBase.extractLatexFromImageSrc = () => null
  mathBase.LOOKS_LIKE_LATEX_RE = /(?!)/
  try {
    return run()
  } finally {
    rules.forEach((rule, i) => (rule.selector = saved[i]))
    Object.assign(mathBase, {
      wrapRawLatexDelimiters,
      extractLatexFromImageSrc,
      LOOKS_LIKE_LATEX_RE
    })
  }
}

function runVariant(html, url, variant) {
  const { options, metadata, small, clone, main, input } = preparePage(html, url)
  input.variant = variant
  if (!main) return { input, steps: null, main: null }
  const doc = main.ownerDocument
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
    withDeferredRulesOff(() => standardize.standardizeContent(main, metadata, doc, false))
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
