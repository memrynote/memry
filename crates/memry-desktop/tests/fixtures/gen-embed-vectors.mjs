// Regenerates electron-vault/resolve-embeds.json from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-embed-vectors.mjs
// Runs `resolveVaultEmbeds` of `vault/resolve-embed.ts` over a real temp vault. Only its
// collaborators are stubbed: the open vault and its config (`vault/index`), the index rows its
// bare-filename lookup reads (`database`, answering with the image rows of `index`), and the
// attachments module for its folder name. The vector holds the vault's files, the index rows,
// and what each batch resolved to. A `memry-file://` URL names the vault root as `<vault>`, and
// a ref names the vault's folder as `<vault-name>`.
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(join(process.cwd(), 'package.json'))
const main = resolve(process.cwd(), 'src/main')
const stub = (path, exports) => {
  const id = require.resolve(path)
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

const vault = realpathSync(mkdtempSync(join(tmpdir(), 'memry-embeds-')))
const state = { notesFolder: '', rows: [] }
stub('electron', { app: { getPath: () => tmpdir() }, BrowserWindow: { getAllWindows: () => [] } })
stub(join(main, 'vault/index.ts'), {
  getStatus: () => ({ isOpen: true, path: vault }),
  getConfig: () => ({ defaultNoteFolder: state.notesFolder })
})
stub(join(main, 'database/index.ts'), {
  getIndexDatabase: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          all: () =>
            state.rows.filter((row) => row.fileType === 'image').map(({ path }) => ({ path }))
        })
      })
    })
  })
})
stub(join(main, 'vault/attachments.ts'), { ATTACHMENTS_DIR: 'attachments' })

const load = async (path) => {
  const ns = await import(path)
  return ns.default ?? ns
}
const { resolveVaultEmbeds } = await load(
  '../../../../apps/desktop/src/main/vault/resolve-embed.ts'
)
console.log = console.warn = console.info = console.debug = () => {}

const files = [
  'Images/photo.png',
  'notes/sub/note.md',
  'notes/sub/sibling.png',
  'notes/sub/pics/inner.png',
  'notes/in-notes.png',
  'Library/in-library.png',
  'attachments/att.png',
  'a b (1).png',
  'weird#name?[x]%20.png',
  'misc/Ärger.PNG',
  'idx/deep/only-index.png',
  'assets/tie.png',
  'Images/tie.png',
  'x/y/z/short.png',
  'q/short.png',
  'root.md',
  '..dots.png',
  'a/b/c/deep.png',
  'z/deep.png'
]
const dirs = ['folder.png']
for (const file of files) {
  mkdirSync(dirname(join(vault, file)), { recursive: true })
  writeFileSync(join(vault, file), 'x')
}
for (const dir of dirs) mkdirSync(join(vault, dir), { recursive: true })
mkdirSync(join(vault, '..', `${vault.split('/').pop()}-outside`), { recursive: true })
writeFileSync(join(vault, '..', `${vault.split('/').pop()}-outside`, 'escape.png'), 'x')

const outside = `../${vault.split('/').pop()}-outside/escape.png`
const index = [
  { path: 'idx/deep/only-index.png', fileType: 'image' },
  { path: 'misc/Ärger.PNG', fileType: 'image' },
  { path: 'assets/tie.png', fileType: 'image' },
  { path: 'Images/tie.png', fileType: 'image' },
  { path: 'x/y/z/short.png', fileType: 'image' },
  { path: 'q/short.png', fileType: 'image' },
  { path: 'gone/ghost.png', fileType: 'image' },
  { path: 'docs/not-an-image.pdf', fileType: 'pdf' },
  { path: '..dots.png', fileType: 'image' },
  { path: 'a/b/c/deep.png', fileType: 'image' },
  { path: 'z/deep.png', fileType: 'image' }
]
state.rows = index

const refs = [
  'Images/photo.png',
  'sibling.png',
  'pics/inner.png',
  'in-notes.png',
  'in-library.png',
  'att.png',
  'a b (1).png',
  'weird#name?[x]%20.png',
  'ärger.png',
  'ÄRGER.png',
  'only-index.png',
  'sub/folder/only-index.png',
  'tie.png',
  'short.png',
  'deep.png',
  'ghost.png',
  'not-an-image.pdf',
  'folder.png',
  'missing.png',
  '../escape.png',
  outside,
  '..dots.png',
  '/Images/photo.png',
  'notes/../Images/photo.png',
  './Images/photo.png',
  '/etc/hosts',
  'https://example.com/a.png',
  'https://example.com/tie.png',
  'memry-file://local/x.png',
  'c:relative.png',
  '',
  '.',
  '__proto__'
]

const placeholder = (value) => value.split(vault.slice(1)).join('<vault>')
const named = (value) => value.split(vault.split('/').pop()).join('<vault-name>')
const run = (notePath, notesFolder) => {
  state.notesFolder = notesFolder
  const resolved = resolveVaultEmbeds(refs, notePath)
  return {
    notePath: notePath ?? null,
    notesFolder,
    resolved: Object.fromEntries(
      Object.entries(resolved).map(([k, v]) => [named(k), placeholder(v)])
    )
  }
}
const cases = [
  run('notes/sub/note.md', ''),
  run('root.md', ''),
  run('notes/sub/note.md', 'Library'),
  run(undefined, ''),
  run('notes/sub/pics/../note.md', '')
]

rmSync(vault, { recursive: true, force: true })
rmSync(join(vault, '..', `${vault.split('/').pop()}-outside`), { recursive: true, force: true })

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'electron-vault'), { recursive: true })
writeFileSync(
  join(here, 'electron-vault', 'resolve-embeds.json'),
  `${JSON.stringify({ files, dirs, index, refs: refs.map(named), cases }, null, 2)}\n`
)
process.exit(0)
