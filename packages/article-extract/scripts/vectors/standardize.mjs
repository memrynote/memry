/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types */
// Standardize vectors: the content element after `standardizeCallouts` and after
// `standardizeContent` (dist/defuddle.js:858-909), in two variants. `direct` runs both on the
// element the content finder picks; `pipeline` runs the metadata block, the callouts and the
// five removal steps of the default run first, as `parseInternal` orders them. The footnote
// steps between them belong to stage 3 and are not run.
//
// `standardizeElements` also converts math, code blocks and images with rules that stage 3 and 4
// port with their elements. Until then those rules are switched off here, so that this class
// holds exactly what the stage 2c port reproduces; `deferredRules` is the list to delete.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { dist } from './probes.mjs'
import { preparePage, removalSteps, removeMetadataBlockStep } from './removals.mjs'

const require = createRequire(join(dist, 'x.js'))
const callouts = require('./elements/callouts.js')
const code = require('./elements/code.js')
const images = require('./elements/images.js')
const math = require('./elements/math.js')
const mathBase = require('./elements/math.base.js')
const standardize = require('./standardize.js')

export const standardizeVariants = ['direct', 'pipeline']
export { URL as standardizeUrl } from './removal-pages.mjs'
const wellFormed = (value) => (typeof value === 'string' ? value.toWellFormed() : value)

/** Runs `run` with the element rules of stages 3 and 4 (math, code blocks, images) switched off:
 *  their selectors match nothing, the LaTeX wrapper does nothing and no `img` looks like LaTeX. */
function withDeferredRulesOff(run) {
  const rules = [...math.mathRules, ...code.codeBlockRules, ...images.imageRules]
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

export function standardizeVector(html, url, variant) {
  const { options, metadata, small, clone, main, input } = preparePage(html, url)
  input.variant = variant
  if (!main) return { input, steps: null }
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
  step('callouts', () => callouts.standardizeCallouts(main))
  if (variant === 'pipeline') {
    const state = { clone, main, small, url, metadata }
    for (const [key, run] of removalSteps) step(key, () => run(state, options))
  }
  step('standardize', () =>
    withDeferredRulesOff(() => standardize.standardizeContent(main, metadata, doc, false))
  )
  return { input, steps }
}

/** Both variants of one page. */
export const standardizeVectors = (html, url) =>
  Object.fromEntries(standardizeVariants.map((v) => [v, standardizeVector(html, url, v)]))
