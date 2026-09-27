// Regenerates brand.js from the master logo so the film never hand-copies brand geometry.
// node brand.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const svg = readFileSync(path.join(dir, '../../assets/brand/memrynote/logo.svg'), 'utf8')
const markD = svg.match(/<path xmlns="http:\/\/www.w3.org\/2000\/svg" d="([^"]+)"/)[1]
const [top, bar] = markD.split(/(?=M0 650)/)
const word = svg.match(/<g transform="translate\(40, 0\)"><path d="([^"]+)" fill="(#[0-9A-Fa-f]+)"/)
// bucket wordmark subpaths into the three sung syllables: mem / ry / note
const chunks = ['', '', '']
for (const sub of word[1].split(/(?=M)/)) {
  const x = parseFloat(sub.slice(1))
  chunks[x < 63 ? 0 : x < 87.5 ? 1 : 2] += sub
}
const out = `// Generated from assets/brand/memrynote/logo.svg by brand.mjs. Do not hand-edit.
window.BRAND = ${JSON.stringify({ markTop: top.trim(), bar: bar.trim(), wordmark: chunks, wordColor: word[2], markColor: '#FF671A' }, null, 1)};
`
writeFileSync(path.join(dir, 'brand.js'), out)
console.log('wrote brand.js')
