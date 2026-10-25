// Writes the HTML entity decode tree of entities@7 (the version htmlparser2 10.1.0 depends on)
// as little-endian u16 words, the table `dom/parse/entities.rs` walks. Run through
// `pnpm --filter @memry/article-extract entities`; `--check` fails when the committed file
// differs, so an `entities` bump forces a re-port decision.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(
  here,
  '../../../crates/memry-desktop/src/web/extract/dom/parse/html_decode_tree.bin'
)

// Follow the dependency chain linkedom -> htmlparser2 -> entities, so that the copy htmlparser2
// really runs on is the one written, not a hoisted one of another version.
function findPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(dir) === dir) throw new Error(`${name} not found from ${fromDir}`)
  }
}
const linkedomRoot = findPackage(here, 'linkedom')
const htmlparser2Root = findPackage(linkedomRoot, 'htmlparser2')
const entitiesRoot = findPackage(htmlparser2Root, 'entities')
const entities = await import(pathToFileURL(join(entitiesRoot, 'dist/esm/decode.js')).href)

const words = entities.htmlDecodeTree
const bytes = Buffer.alloc(words.length * 2)
words.forEach((word, i) => bytes.writeUInt16LE(word, i * 2))

if (process.argv.includes('--check')) {
  let committed
  try {
    committed = readFileSync(target)
  } catch {
    committed = Buffer.alloc(0)
  }
  if (!committed.equals(bytes)) {
    console.error(
      'html_decode_tree.bin differs from entities@7; run pnpm --filter @memry/article-extract entities'
    )
    process.exit(1)
  }
  console.log(`html_decode_tree.bin matches entities (${words.length} words)`)
} else {
  writeFileSync(target, bytes)
  console.log(`wrote ${words.length} words to ${target}`)
}
