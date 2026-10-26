#!/usr/bin/env node
// Seeds the cargo-fuzz corpora of crates/memry-core/fuzz with the inputs of the
// committed markdown-convert vectors (#3522): every markdown body the oracle has
// answered is a starting point the mutator can bend. Usage:
//   node scripts/markdown-fuzz-seeds.mjs
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const vectors = join(root, 'packages/contracts/test-vectors/markdown-convert')
const corpus = join(root, 'crates/memry-core/fuzz/corpus')
const files = ['seed-doc.json', 'grammar-corpus.json', 'seed-corpus.json', 'memry-parse.json']

const bodies = new Set()
for (const name of files) {
  const { cases } = JSON.parse(readFileSync(join(vectors, name), 'utf8'))
  for (const c of cases) if (typeof c.input?.markdown === 'string') bodies.add(c.input.markdown)
}

// Shapes that once overflowed the stack or went quadratic (#3522): the mutator
// grows and bends them.
for (const n of [90, 300, 1000]) {
  bodies.add(`${'['.repeat(n)}x${'](u)'.repeat(n)}`)
  bodies.add(`${'[a '.repeat(n)}${'](u)'.repeat(n)}`)
  bodies.add(`${'[*'.repeat(n)}x${'*](u)'.repeat(n)}`)
  bodies.add('**a *b '.repeat(n))
  bodies.add(`${'> '.repeat(n)}x`)
  bodies.add('<details>\n<summary>t</summary>\n\n'.repeat(n))
  bodies.add(`${'<div>'.repeat(n)}x`)
}

const targets = {
  convert_roundtrip: (body) => body,
  // `base NUL replacement`: replace each body with the next one.
  replace_body: (body, next) => `${body}\0${next}`,
  frontmatter_split: (body) => body
}
const list = [...bodies]
for (const [target, make] of Object.entries(targets)) {
  const dir = join(corpus, target)
  mkdirSync(dir, { recursive: true })
  list.forEach((body, i) => {
    const input = make(body, list[(i + 1) % list.length])
    const name = createHash('sha1').update(input).digest('hex')
    writeFileSync(join(dir, name), input)
  })
}
process.stdout.write(`seeded ${list.length} bodies into ${Object.keys(targets).length} corpora\n`)
