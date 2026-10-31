// Regenerates electron-vault/home-cover-paths.json from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-cover-vectors.mjs
// Runs `homeCoverFilePath` of `home/cover-service.ts`, which maps a board cover's synced ref to
// the file it names, or refuses it. Its collaborators (`electron`, the sync, Unsplash and vault
// modules it imports) are stubbed: the function reads none of them. A path is written relative
// to the vault, `/`-separated.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(join(process.cwd(), 'package.json'))
const main = resolve(process.cwd(), 'src/main')
const noop = () => undefined
const stub = (path, exports) => {
  const id = require.resolve(path)
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
stub('electron', {
  app: { getPath: () => tmpdir(), isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  net: {},
  safeStorage: {},
  shell: {}
})
for (const module of [
  'ipc/sync-attachment-handlers.ts',
  'lib/logger.ts',
  'lib/window-broadcast.ts',
  'unsplash/service.ts',
  'vault/attachments.ts',
  'vault/file-ops.ts',
  'vault/index.ts',
  'vault/remote-attachment.ts',
  'home/runtime-effects.ts',
  'home/store.ts'
]) {
  stub(join(main, module), {
    createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop })
  })
}

const { homeCoverFilePath } =
  await import('../../../../apps/desktop/src/main/home/cover-service.ts')
console.log = console.warn = console.info = console.debug = () => {}

const vault = join(tmpdir(), 'memry-cover-vault')
const board = 'b1'
const refs = [
  '.memry/home-covers/b1/abc123-photo.png',
  '.memry/home-covers/b1/a b (1).png',
  '.memry/home-covers/b1/.hidden.png',
  '.memry/home-covers/b1/..png',
  '.memry/home-covers/b1/',
  '.memry/home-covers/b1/.',
  '.memry/home-covers/b1/..',
  '.memry/home-covers/b1/sub/photo.png',
  '.memry/home-covers/b1/sub\\photo.png',
  '.memry/home-covers/b1/../b2/photo.png',
  '.memry/home-covers/b2/photo.png',
  '.memry/home-covers/b10/photo.png',
  '.memry/home-covers/b1',
  '.memry/home-covers/B1/photo.png',
  './.memry/home-covers/b1/photo.png',
  '/.memry/home-covers/b1/photo.png',
  'wash:ocean',
  'https://example.com/photo.png',
  ''
]
const cases = refs.map((ref) => {
  const path = homeCoverFilePath(vault, board, ref)
  return { ref, path: path === null ? null : relative(vault, path).split(sep).join('/') }
})

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'electron-vault'), { recursive: true })
writeFileSync(
  join(here, 'electron-vault', 'home-cover-paths.json'),
  `${JSON.stringify({ board, cases }, null, 2)}\n`
)
process.exit(0)
