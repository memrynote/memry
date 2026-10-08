#!/usr/bin/env node
// Uploads the OCR language data that GET /ocr/v1/:lang.traineddata.gz serves.
// Kaan runs this by hand. CI and deploys never do.
//
//   node scripts/upload-ocr-language-data.ts --env staging
//   node scripts/upload-ocr-language-data.ts --env production
//   node scripts/upload-ocr-language-data.ts --env local [--persist-to <dir>]
//
// Files are Tesseract's tessdata_fast models at the pinned tag, gzipped once into
// --dir (default ~/.cache/memry/ocr-data/<commit>). Run staging first, then
// production, from the same --dir so both buckets hold the same bytes. Desktop pins each file's
// sha256 from ocr/v1/manifest.json, so a key already in the remote manifest is
// never replaced with different bytes: the script stops instead.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'

import {
  OCR_LANGUAGES,
  OCR_MANIFEST_KEY,
  ocrLanguageKey,
  type OcrLanguage
} from '../src/lib/ocr-languages.ts'

// tessdata_fast tag 4.1.0. Its models are still the current ones for Tesseract 5,
// which tesseract.js 7 runs.
const TESSDATA_FAST_COMMIT = '65727574dfcd264acbb0c3e07860e4e9e9b22185'
const BUCKETS = {
  local: 'memry-encrypted-blobs-staging',
  staging: 'memry-encrypted-blobs-staging',
  production: 'memry-encrypted-blobs-production'
} as const

type Env = keyof typeof BUCKETS
interface ManifestEntry {
  lang: string
  bytes: number
  sha256: string
}

const SYNC_SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const { values } = parseArgs({
  options: {
    env: { type: 'string' },
    dir: {
      type: 'string',
      default: join(homedir(), '.cache', 'memry', 'ocr-data', TESSDATA_FAST_COMMIT)
    },
    'persist-to': { type: 'string' }
  }
})

const env = values.env
if (env !== 'local' && env !== 'staging' && env !== 'production') {
  console.error('Usage: node scripts/upload-ocr-language-data.ts --env <local|staging|production>')
  process.exit(1)
}
if (values['persist-to'] && env !== 'local') {
  console.error('--persist-to only applies to --env local')
  process.exit(1)
}

const bucket = BUCKETS[env as Env]
const dataDir = resolve(values.dir)
const target =
  env === 'local'
    ? ['--local', ...(values['persist-to'] ? ['--persist-to', resolve(values['persist-to'])] : [])]
    : ['--remote']

function wrangler(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args, ...target], {
    cwd: SYNC_SERVER_DIR,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  })
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr }
}

async function readOrDownload(file: string, lang: OcrLanguage): Promise<Buffer> {
  try {
    return readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const url = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_FAST_COMMIT}/${lang}.traineddata`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  const data = gzipSync(Buffer.from(await response.arrayBuffer()), { level: 9 })
  writeFileSync(file, data, { flag: 'wx' })
  return data
}

async function buildLanguage(lang: OcrLanguage): Promise<ManifestEntry> {
  const data = await readOrDownload(join(dataDir, `${lang}.traineddata.gz`), lang)
  return { lang, bytes: data.byteLength, sha256: createHash('sha256').update(data).digest('hex') }
}

function readRemoteManifest(): Map<string, ManifestEntry> {
  const result = wrangler(['r2', 'object', 'get', `${bucket}/${OCR_MANIFEST_KEY}`, '--pipe'])
  if (!result.ok) {
    if (/specified key does not exist/i.test(result.stderr + result.stdout)) return new Map()
    throw new Error(`Reading ${OCR_MANIFEST_KEY} failed:\n${result.stderr}`)
  }
  const entries = JSON.parse(result.stdout) as ManifestEntry[]
  return new Map(entries.map((entry) => [entry.lang, entry]))
}

function put(key: string, file: string, contentType: string): void {
  const result = wrangler([
    'r2',
    'object',
    'put',
    `${bucket}/${key}`,
    '--file',
    file,
    '--content-type',
    contentType
  ])
  if (!result.ok) throw new Error(`Uploading ${key} failed:\n${result.stderr}`)
}

mkdirSync(dataDir, { recursive: true })
const built = new Map<OcrLanguage, ManifestEntry>()
for (const lang of OCR_LANGUAGES) {
  built.set(lang, await buildLanguage(lang))
}
const manifest = [...built.values()]
const manifestFile = join(dataDir, 'manifest.json')
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

const remote = readRemoteManifest()
const changed = manifest.filter((entry) => {
  const existing = remote.get(entry.lang)
  return existing && existing.sha256 !== entry.sha256
})
if (changed.length > 0) {
  console.error(
    `Refusing to replace data clients may pin: ${changed.map((entry) => entry.lang).join(', ')} ` +
      `differ from ${bucket}/${OCR_MANIFEST_KEY}. Upload from the --dir that produced it.`
  )
  process.exit(1)
}

for (const [lang, entry] of built) {
  if (remote.has(lang)) {
    console.log(`${lang}: already uploaded`)
    continue
  }
  put(ocrLanguageKey(lang), join(dataDir, `${lang}.traineddata.gz`), 'application/gzip')
  console.log(`${lang}: uploaded ${entry.bytes} bytes`)
}
put(OCR_MANIFEST_KEY, manifestFile, 'application/json')
console.log(
  `Wrote ${bucket}/${OCR_MANIFEST_KEY} (${manifest.length} languages), copy at ${manifestFile}`
)
