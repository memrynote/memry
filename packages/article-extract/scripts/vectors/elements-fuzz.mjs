// Seeded random pages for the element handlers of stage 3: prose with a few random footnote,
// code and image families, some of them broken (a note without a reference, a reference without a
// note, a note dropped), in the `direct` variant of the standardize vectors.
import {
  codeFamilies,
  footnoteFamilies,
  imageFamilies,
  mathFamilies,
  nums
} from './element-families.mjs'
import { rng } from './dom.mjs'
import { page, prose } from './removal-pages.mjs'
import { standardizeUrl, standardizeVector } from './standardize.mjs'

const FOOTNOTES = Object.keys(footnoteFamilies)
const CODE = Object.keys(codeFamilies)
const IMAGES = Object.keys(imageFamilies)
const MATH = Object.keys(mathFamilies)

export function elementsFuzzVectors(count) {
  const random = rng(0x3543e1)
  const pick = (list) => list[Math.floor(random() * list.length)]
  return Array.from({ length: count }, () => {
    const parts = [prose(1)]
    const kinds = 1 + Math.floor(random() * 3)
    for (let k = 0; k < kinds; k += 1) {
      const roll = random()
      if (roll < 0.55) {
        const family = footnoteFamilies[pick(FOOTNOTES)]
        const total = 1 + Math.floor(random() * 4)
        const refs = nums(total).filter(() => random() > 0.2)
        const body = refs.map(
          (n) => `<p>Some words here, and more words ${family.refs(n)} done.</p>`
        )
        const defs = family.defs(total)
        parts.push(random() < 0.15 ? defs + body.join('') : body.join('') + defs)
      } else if (roll < 0.75) {
        parts.push(`<p>intro words, more words.</p>${codeFamilies[pick(CODE)]()}`)
      } else if (roll < 0.9) {
        parts.push(`<p>intro words, more words.</p>${imageFamilies[pick(IMAGES)]()}`)
      } else {
        const inline = random() < 0.5
        const eq = mathFamilies[pick(MATH)]()
        parts.push(inline ? `<p>Words here ${eq} and more words.</p>` : `<div>${eq}</div>`)
      }
      if (random() < 0.5) parts.push(prose(1, k + 1))
    }
    const html = page(parts.join(''))
    return { html, ...standardizeVector(html, standardizeUrl, 'direct') }
  })
}
