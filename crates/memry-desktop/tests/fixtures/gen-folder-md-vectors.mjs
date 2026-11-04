// Regenerates electron-vault/folder-md.json from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-folder-md-vectors.mjs
// `writes`: the bytes `writeFolderConfig` (apps/desktop/src/main/vault/folders.ts) leaves for a
// config, `null` when it leaves no file. `reads`: what `readFolderConfig` makes of a file
// (`null`: it could not read it). `sets`: the bytes of `notes:set-folder-config`
// (apps/desktop/src/main/ipc/notes-handlers.ts) over a file, with its merge copied below.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const load = async (path) => {
  const ns = await import(path)
  return ns.default ?? ns
}
const folders = await load('../../../../apps/desktop/src/main/vault/folders.ts')
const status = await load('../../../../apps/desktop/src/main/vault/status.ts')

console.log = console.warn = console.info = console.debug = console.error = () => {}

const vault = mkdtempSync(join(tmpdir(), 'folder-md-'))
// `updateStatus` broadcasts to the windows, which a script has none of, after it set the path.
try {
  status.updateStatus({ path: vault })
} catch {}
const file = join(vault, 'f', '.folder.md')

const leftBytes = () => (existsSync(file) ? readFileSync(file, 'utf8') : null)
const put = (bytes) => {
  rmSync(join(vault, 'f'), { recursive: true, force: true })
  if (bytes !== null) {
    mkdirSync(join(vault, 'f'), { recursive: true })
    writeFileSync(file, bytes)
  }
}

const writes = []
for (const [name, config] of [
  ['empty', {}],
  ['inherit-true-only', { inherit: true }],
  ['icon', { icon: 'lucide:folder' }],
  ['icon-emoji-astral', { icon: 'emoji:\u{1F4C1}' }],
  ['icon-needs-quotes', { icon: 'a: b # c' }],
  ['template', { template: 'meeting-notes' }],
  ['inherit-false', { inherit: false }],
  ['views', { views: [{ id: 'v1', name: 'Table', type: 'table', columns: [{ id: 'title' }] }] }],
  ['views-empty', { views: [], icon: 'x' }],
  ['formulas', { formulas: { total: 'price * qty' } }],
  ['formulas-empty', { formulas: {} }],
  ['properties', { properties: { status: { displayName: 'State' } } }],
  ['summaries', { summaries: { price: 'sum' } }],
  [
    'everything',
    {
      icon: 'emoji:\u{2B50}',
      template: 'daily',
      inherit: false,
      views: [{ id: 'v1', name: 'All', type: 'table' }],
      formulas: { a: '1 + 2' },
      properties: { a: { width: 120 } },
      summaries: { a: 'count' }
    }
  ],
  ['multiline-template', { template: 'line one\nline two' }]
]) {
  put(null)
  await folders.writeFolderConfig('f', config)
  writes.push({ name, config, bytes: leftBytes() })
}

const reads = []
for (const [name, input] of [
  ['electron', writes.find((c) => c.name === 'everything').bytes],
  ['crlf', '---\r\nicon: lucide:star\r\ntemplate: t\r\n---\r\n'],
  ['bom', '\uFEFF---\nicon: lucide:star\n---\n'],
  ['unknown-keys', '---\nicon: x\nsort: manual\ncolor: red\n---\n'],
  ['body-after', '---\ntemplate: t\n---\n\nSome text\n'],
  ['no-frontmatter', 'just text\n'],
  ['empty', ''],
  ['empty-block', '---\n---\n'],
  ['inherit-string', '---\ninherit: "false"\n---\n'],
  ['inherit-false', '---\ninherit: false\n---\n'],
  ['icon-number', '---\nicon: 42\ntemplate: [a]\n---\n'],
  ['views-object', '---\nviews:\n  a: 1\n---\n'],
  ['formulas-array', '---\nformulas:\n  - a\n---\n'],
  ['formulas-scalar', '---\nformulas: 3\n---\n'],
  ['broken-yaml', '---\nviews: [\n---\n'],
  ['frontmatter-list', '---\n- a\n- b\n---\n'],
  ['anchors', '---\nformulas: &f\n  a: b\nproperties: *f\n---\n']
]) {
  put(input)
  reads.push({ name, input, config: await folders.readFolderConfig('f') })
}

// The handler of `notes:set-folder-config`, as written there: the icon kept when the key is
// absent, the views, formulas, properties and summaries read back from the file.
async function setFolderConfig(folderPath, config) {
  const current = (await folders.readFolderConfig(folderPath)) ?? {}
  const icon = 'icon' in config ? (config.icon ?? null) : (current.icon ?? null)
  await folders.writeFolderConfig(folderPath, {
    ...config,
    icon,
    views: current.views,
    formulas: current.formulas,
    properties: current.properties,
    summaries: current.summaries
  })
}

const viewsFile = writes.find((c) => c.name === 'views').bytes
const everything = writes.find((c) => c.name === 'everything').bytes
const sets = []
// `config` is the input after `FolderConfigSchema` parsed it: `inherit` defaults to true.
for (const [name, before, config] of [
  ['template-on-missing', null, { template: 'daily', inherit: true }],
  ['icon-on-missing', null, { icon: 'lucide:book', inherit: true }],
  ['template-keeps-views', viewsFile, { template: 'daily', inherit: true }],
  ['absent-icon-keeps-it', everything, { template: 'other', inherit: true }],
  ['null-icon-clears-it', everything, { icon: null, template: 'daily', inherit: false }],
  ['clear-all', '---\nicon: x\ntemplate: t\n---\n\n', { icon: null, inherit: true }],
  ['inherit-false', '---\ntemplate: t\n---\n\n', { template: 't', inherit: false }],
  ['crlf-file', '---\r\nicon: x\r\n---\r\n', { template: 't', inherit: true }],
  ['empty-file', '', { icon: 'y', inherit: true }]
]) {
  put(before)
  await setFolderConfig('f', config)
  sets.push({ name, before, config, bytes: leftBytes() })
}

rmSync(vault, { recursive: true, force: true })
const out = join(dirname(fileURLToPath(import.meta.url)), 'electron-vault', 'folder-md.json')
writeFileSync(out, `${JSON.stringify({ writes, reads, sets }, null, 2)}\n`)
