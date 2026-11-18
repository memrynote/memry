#!/usr/bin/env node
// Golden vectors for the Inbox metadata scraper in Rust
// (`crates/memry-desktop/src/services/web_fetch/metadata/`).
//
// Runs metascraper 5.49.21 with the eight rule bundles Electron loads
// (`apps/desktop/src/main/inbox/metadata.ts:12-31`) over every page of
// `crates/memry-desktop/tests/fixtures/metadata/pages.json`, applies Electron's
// bot-wall check and `|| undefined` mapping (`metadata.ts:203-222`), and writes
// `expected.json`. It also writes `url_regex.txt`, the `isUrl` pattern of
// `url-regex-safe` (with its `tlds` list) translated for the Rust `regex` crate.
//
// Dates without a timezone are local in metascraper, so this runs in UTC, the
// timezone the Rust test reads them in.
//
// Usage: node scripts/generate-metadata-vectors.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Node reads TZ at the first local-time operation, which comes later.
process.env.TZ = 'UTC'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'crates/memry-desktop/tests/fixtures/metadata')
const regexOut = join(root, 'crates/memry-desktop/src/services/web_fetch/metadata/url_regex.txt')
const check = process.argv.includes('--check')

const metascraper = require('metascraper')
const scraper = metascraper(
  [
    'metascraper-author',
    'metascraper-date',
    'metascraper-description',
    'metascraper-image',
    'metascraper-logo',
    'metascraper-publisher',
    'metascraper-title',
    'metascraper-url'
  ].map((name) => require(name)())
)

// `isBotPageTitle` (`apps/desktop/src/main/inbox/metadata-utils.ts:3-20`).
const BOT_PAGE_TITLES = [
  'just a moment...',
  'attention required!',
  'access denied',
  'please wait',
  'verify you are human',
  'checking your browser'
]
const isBotPageTitle = (title) => BOT_PAGE_TITLES.some((bot) => title.toLowerCase().includes(bot))

// The body as `decode_text` reads it: the `charset` of the content type, else UTF-8.
function decode(bytes, contentType) {
  const charset = /;\s*charset\s*=\s*"?([^";]+)/i.exec(contentType ?? '')?.[1]?.trim()
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

async function fetchUrlMetadata(html, url) {
  const metadata = await scraper({ html, url })
  if (metadata.title && isBotPageTitle(metadata.title)) return { url }
  const out = {
    title: metadata.title || undefined,
    description: metadata.description || undefined,
    image: metadata.image || undefined,
    author: metadata.author || undefined,
    publisher: metadata.publisher || undefined,
    date: metadata.date || undefined,
    logo: metadata.logo || undefined,
    url: metadata.url || url
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined))
}

// url-regex-safe resolved through metascraper's own dependency chain.
function urlRegex() {
  const helpers = createRequire(require.resolve('metascraper')).resolve('@metascraper/helpers')
  const createRegex = createRequire(helpers)('url-regex-safe')
  const source = createRegex({ exact: true, parens: true, re2: false, returnString: true })
  let out = ''
  let inClass = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '\\') {
      const next = source[i + 1]
      if (next === 'u') {
        const hex = source.slice(i + 2, i + 6)
        // `\uffff` closes a UTF-16 range; astral characters are two units both in it.
        out += hex.toLowerCase() === 'ffff' ? '\\x{10FFFF}' : `\\x{${hex}}`
        i += 5
      } else if (next === 'd') {
        out += inClass ? '0-9' : '[0-9]'
        i += 1
      } else if (next === 's') {
        out += inClass ? '\\s\\x{FEFF}' : '[\\s\\x{FEFF}]'
        i += 1
      } else {
        out += c + next
        i += 1
      }
      continue
    }
    if (c === '[' && !inClass) inClass = true
    else if (c === ']' && inClass) inClass = false
    out += c
  }
  return `(?i)^(?:${out})$\n`
}

const pages = JSON.parse(readFileSync(join(fixtures, 'pages.json'), 'utf8'))
const expected = {}
for (const page of pages) {
  const html = decode(readFileSync(join(fixtures, 'pages', page.file)), page.contentType)
  try {
    expected[page.file] = await fetchUrlMetadata(html, page.url)
  } catch (error) {
    expected[page.file] = { error: error.message }
  }
}

const outputs = [
  [join(fixtures, 'expected.json'), JSON.stringify(expected, null, 2) + '\n'],
  [regexOut, urlRegex()]
]
let stale = false
for (const [path, text] of outputs) {
  if (check) {
    let current = ''
    try {
      current = readFileSync(path, 'utf8')
    } catch {}
    if (current !== text) {
      console.error(`stale: ${path}`)
      stale = true
    }
  } else {
    writeFileSync(path, text)
  }
}
if (stale) process.exit(1)
console.log(`${pages.length} pages`)
