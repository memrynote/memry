// Writes apps/ios/Memry/Resources/emoji.json from the same @emoji-mart/data
// set the desktop picker uses, so both pickers offer the same emoji.
//
//   node scripts/generate-ios-emoji-data.mjs
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const data = require('@emoji-mart/data/sets/15/native.json')

// [category id, emoji, search text]; the text is lowercased name + keywords.
const categories = data.categories.map((category) => ({
  id: category.id,
  emojis: category.emojis.flatMap((id) => {
    const emoji = data.emojis[id]
    const native = emoji?.skins?.[0]?.native
    if (!native) return []
    const text = [emoji.name, ...(emoji.keywords ?? [])].join(' ').toLowerCase()
    return [[native, text]]
  })
}))

const out = path.join(root, 'apps/ios/Memry/Resources/emoji.json')
writeFileSync(out, JSON.stringify(categories))
console.log(`wrote ${categories.reduce((n, c) => n + c.emojis.length, 0)} emoji to ${out}`)
