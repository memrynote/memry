// Regenerates the vault vectors from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-vault-vectors.mjs
// Writes content-hash.json, sanitize-filename.json and file-types.json next to this file.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The sources are CommonJS under tsx, so named imports are read off the namespace.
const load = async (path) => {
  const ns = await import(path)
  return ns.default ?? ns
}
const fm = await load('../../../../apps/desktop/src/main/vault/frontmatter.ts')
const fileOps = await load('../../../../apps/desktop/src/main/vault/file-ops.ts')
const fileTypes = await load('../../../../packages/shared/src/file-types.ts')
const { generateContentHash, createContentHasher } = fm
const { sanitizeFilename } = fileOps
const { getFileType, getMimeType, isSupportedPath } = fileTypes

const here = dirname(fileURLToPath(import.meta.url))
const write = (name, value) =>
  writeFileSync(join(here, name), JSON.stringify(value, null, 2) + '\n')

// Inputs are UTF-16 code unit arrays so a lone surrogate survives JSON.
const units = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i))
const hashCases = [
  ['empty', ''],
  ['ascii', 'hello world'],
  ['frontmatter', '---\ntitle: A\n---\nBody\n'],
  ['crlf', 'a\r\nb\r\n'],
  ['bom', '\uFEFF# Title\n'],
  ['two-byte', 'caf\u00e9 na\u00efve'],
  ['cjk', '\u65e5\u672c\u8a9e\u306e\u30e1\u30e2'],
  ['astral', 'rocket \u{1F680} and \u{1D11E}'],
  ['lone-high-surrogate', 'a\uD83Db'],
  ['lone-low-surrogate', 'a\uDE80b'],
  ['reversed-pair', '\uDE80\uD83D'],
  ['nul', 'a\u0000b']
].map(([name, text]) => ({ name, units: units(text), hash: generateContentHash(text) }))

// 3 MB fed in 64 KB chunks must equal the one-shot hash.
const big = Array.from({ length: 3_000_000 }, (_, i) => String.fromCharCode(32 + (i % 90))).join('')
const hasher = createContentHasher()
for (let i = 0; i < big.length; i += 65536) hasher.update(big.slice(i, i + 65536))
const bigHash = hasher.digest()
if (bigHash !== generateContentHash(big)) throw new Error('streaming hash differs')
write('content-hash.json', {
  cases: hashCases,
  big: { length: 3_000_000, pattern: 'char(32 + i % 90)', chunk: 65536, hash: bigHash }
})

const names = [
  'My Note',
  '  spaced   out  ',
  'a/b\\c',
  '<>:"|?*',
  '[x]#y^z',
  '.hidden',
  '...',
  '. Report',
  '..',
  '',
  '   ',
  'tab\tand\nnewline',
  'caf\u00e9',
  'a'.repeat(250),
  '\u{1F680}'.repeat(150),
  '\u00a0nbsp\u00a0',
  'a\u0085b',
  '\u2003em\u2003',
  '\uFEFFbom',
  'x'.repeat(199) + '\u{1F680}',
  'con',
  'name.',
  'ends with space '
]
write('sanitize-filename.json', {
  cases: names.map((input) => ({ input: units(input), output: units(sanitizeFilename(input)) }))
})

const paths = [
  'a.md',
  'A.MD',
  'x.pdf',
  'p.PNG',
  'x.jpeg',
  'x.svg',
  'x.mp3',
  'x.m4a',
  'x.mkv',
  'x.mov',
  'x.txt',
  'x',
  '.md',
  'x.',
  'a.b.md',
  'dir.md/file',
  'x.excalidraw',
  'x.docx',
  'noext.',
  'x.webp'
]
write('file-types.json', {
  cases: paths.map((path) => {
    const ext = path.slice(path.lastIndexOf('.') + 1)
    return {
      path,
      supported: isSupportedPath(path),
      fileType: getFileType(path.lastIndexOf('.') === -1 ? '' : ext),
      mime: getMimeType(path.lastIndexOf('.') === -1 ? '' : ext)
    }
  })
})
