// Regenerates electron-vault/attachment-names.json from the Electron code:
//   cd apps/desktop && npx tsx ../../crates/memry-desktop/tests/fixtures/gen-attachment-vectors.mjs
// Runs `generateUniqueFilename`, `getFileExtension`, `isAllowedFileType`, `getMimeType`,
// `getFileType`, `formatFileSize` and `getAttachmentRef` of `vault/attachments.ts`, the layout of
// a note's attachments. A stored name starts with a random `<6 of 0-9a-z>-` prefix, so a case
// records what follows it. The modules that reach the database, the vault state, the reference
// scan and the locks are stubbed: these functions read none of them.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(join(process.cwd(), 'package.json'))
const main = resolve(process.cwd(), 'src/main')
const noop = () => undefined
const stub = (path, exports) => {
  const id = require.resolve(path)
  require.cache[id] = { id, filename: id, loaded: true, exports }
}
stub('electron', { app: {}, shell: {}, net: {} })
for (const module of [
  'database/index.ts',
  'database/queries/notes/note-crud.ts',
  'vault/status.ts',
  'telemetry/diagnostics.ts',
  'vault/attachment-reference-scan.ts',
  'vault-locks/registry.ts',
  'lib/logger.ts'
]) {
  stub(join(main, module), {
    createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop })
  })
}

const attachments = await import('../../../../apps/desktop/src/main/vault/attachments.ts')
console.log = console.warn = console.info = console.debug = () => {}

const names = [
  'my-image.png',
  'file.png',
  'file.pdf',
  'file<name>.png',
  'Pasted Graphic (1).png',
  'a  b\tc.png',
  '{braces}.pdf',
  '(1).png',
  '---.png',
  '-lead-trail-.png',
  'Photo.PNG',
  'x..png',
  '..png',
  'a.tar.md',
  '.hidden.md',
  'CON.png',
  'nul.txt',
  'COM1.pdf',
  'Résumé – final.docx',
  '日本語のファイル.pdf',
  'a:b*c?d"e|f.png',
  '[link]#^.md',
  '   spaced   .png',
  'trailing dots....pdf',
  'tab\u00a0nbsp\u3000ideo.png',
  'clip.mov',
  '../../escape.png',
  '/etc/passwd.md',
  'trailing. .pdf'
]
const unique = names.map((name) => {
  const stored = attachments.generateUniqueFilename(name)
  if (!/^[0-9a-z]{6}-/.test(stored)) throw new Error(`unexpected prefix: ${stored}`)
  return { name, stored: stored.slice(7) }
})

const extensions = [
  'file.png',
  'file.PNG',
  'file.tar.gz',
  'noext',
  '.png',
  '..png',
  'a.',
  '..',
  'x..png',
  '.hidden.MD',
  'report.HTM',
  'report.xhtml',
  'clip.mp4',
  'clip.webm',
  'clip.MOV',
  'clip.avi',
  'clip.mkv',
  'file.exe',
  'file.sh',
  'file.js',
  'file.svg',
  'file.docx',
  'file.xlsx',
  'file.unknown'
].map((name) => ({
  name,
  ext: attachments.getFileExtension(name),
  allowed: attachments.isAllowedFileType(name),
  mime: attachments.getMimeType(name),
  type: attachments.getFileType(name)
}))

const sizes = [0, 500, 1023, 1024, 1536, 1048575, 1048576, 5.5 * 1048576, 104857600, 104857601].map(
  (bytes) => ({ bytes, text: attachments.formatFileSize(bytes) })
)

const refs = [
  'notes/Meeting.md',
  'Plan.md',
  'notes/work/q3/Review.md',
  'attachments/note123/inner.md',
  'attachments/other/inner.md',
  'journal/2026-01-01.md'
].map((notePath) => ({
  notePath,
  ref: attachments.getAttachmentRef('/vault', 'note123', 'abc123-x.png', notePath)
}))

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'electron-vault'), { recursive: true })
writeFileSync(
  join(here, 'electron-vault', 'attachment-names.json'),
  `${JSON.stringify({ maxFileSize: attachments.MAX_FILE_SIZE, unique, extensions, sizes, refs }, null, 2)}\n`
)
process.exit(0)
