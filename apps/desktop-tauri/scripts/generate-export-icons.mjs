#!/usr/bin/env node
/**
 * Writes `crates/memry-desktop/resources/export-icons.json.gz`: every glyph of
 * `@hugeicons/core-free-icons`, by export name, for the header of a note
 * exported with a library icon (`icon:<Name>`). Electron imported the package
 * at export time; the Rust export reads this file instead
 * (`memry_desktop::export::library_icon`).
 *
 * Format: `{ "glyphs": [...], "names": { "<export name>": <glyph index> } }`.
 * The package exports each glyph under several names (`Home01Icon`,
 * `Home01FreeIcons`, ...), so each distinct glyph is stored once. A glyph is a
 * list of `[tag, [[attribute, value], ...]]` with attribute order kept, every
 * value a string (`String(value)`, as the export prints it) and React's `key`
 * left out, as the export leaves it out.
 *
 *   node scripts/generate-export-icons.mjs           # write
 *   node scripts/generate-export-icons.mjs --check   # fail if stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

import * as hugeicons from '@hugeicons/core-free-icons'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = resolve(appRoot, '../../crates/memry-desktop/resources/export-icons.json.gz')

function iconsJson() {
  const glyphs = []
  const indexes = new Map()
  const names = {}
  const entries = Object.entries(hugeicons).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [name, glyph] of entries) {
    if (!Array.isArray(glyph)) continue
    const parts = glyph.map(([tag, attrs]) => [
      tag,
      Object.entries(attrs)
        .filter(([attr]) => attr !== 'key')
        .map(([attr, value]) => [attr, String(value)])
    ])
    const key = JSON.stringify(parts)
    if (!indexes.has(key)) {
      indexes.set(key, glyphs.length)
      glyphs.push(parts)
    }
    names[name] = indexes.get(key)
  }
  return JSON.stringify({ glyphs, names })
}

const json = iconsJson()
if (process.argv.includes('--check')) {
  let committed = ''
  try {
    committed = gunzipSync(readFileSync(outputPath)).toString('utf8')
  } catch {
    committed = ''
  }
  if (committed !== json) {
    process.stderr.write(
      'check:export-icons failed: export-icons.json.gz is missing or stale.\n' +
        'Regenerate with `pnpm --filter @memry/desktop-tauri generate:export-icons`.\n'
    )
    process.exit(1)
  }
  process.stdout.write('check:export-icons passed\n')
} else {
  writeFileSync(outputPath, gzipSync(json, { level: 9 }))
  process.stdout.write(`wrote ${outputPath}\n`)
}
