#!/usr/bin/env node
/**
 * Downloads the pdfium library the `memry-ml-worker` sidecar binds at run time (#3542, R2):
 * bblanchon/pdfium-binaries chromium/7881, the build `pdfium-render`'s `pdfium_7881` feature
 * targets. Each archive's sha256 is pinned below; a mismatch fails without writing anything.
 *
 *   node scripts/fetch-pdfium.mjs [--target <darwin-arm64|darwin-x64|win32-x64|win32-arm64|linux-x64>] [--out <dir>]
 *
 * Writes `<out>/<library>` and `<out>/LICENSE`. The default `<out>` is
 * `apps/desktop-tauri/src-tauri/resources/pdfium` (gitignored), which debug builds of the app
 * read; a release bundle places the same files in its resource dir under `pdfium/`. A second run
 * with the same pin downloads nothing.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASE = 'chromium/7881'
const BASE = `https://github.com/bblanchon/pdfium-binaries/releases/download/${RELEASE}`

/** Node's `${platform}-${arch}` to the archive, its sha256 and the library inside it. */
export const PINS = {
  'darwin-arm64': {
    archive: 'pdfium-mac-arm64.tgz',
    sha256: '52e94ca5aa8847934330daf3f8150c190682c5ca93831468794f8b90d4392e40',
    library: 'lib/libpdfium.dylib'
  },
  'darwin-x64': {
    archive: 'pdfium-mac-x64.tgz',
    sha256: '6dedf83990e0e3d6b7c93c9e7589c5a126b0ae14b7464d76120cff7a26afb18b',
    library: 'lib/libpdfium.dylib'
  },
  'win32-x64': {
    archive: 'pdfium-win-x64.tgz',
    sha256: '73cc0de638ac2095e7445bf56a38200a5b7c7ca0e9f4ba144598f2457377ac08',
    library: 'bin/pdfium.dll'
  },
  'win32-arm64': {
    archive: 'pdfium-win-arm64.tgz',
    sha256: 'd3035d4d2cacac6ecd1a2ece197a3d702a1b2a58466276b9f870b8cb278a9d84',
    library: 'bin/pdfium.dll'
  },
  'linux-x64': {
    archive: 'pdfium-linux-x64.tgz',
    sha256: '1470e21b8b4a3b4ad7f85684e2da11d94f3b69a86d81dee11b9b6709d927ac1d',
    library: 'lib/libpdfium.so'
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const target = option('--target') ?? `${process.platform}-${process.arch}`
  const pin = PINS[target]
  if (!pin) throw new Error(`no pdfium pin for ${target}; known: ${Object.keys(PINS).join(', ')}`)
  const out = resolve(
    option('--out') ?? join(repoRoot, 'apps/desktop-tauri/src-tauri/resources/pdfium')
  )
  const library = join(out, pin.library.split('/').pop())
  const stamp = join(out, '.pin')
  if (existsSync(library) && existsSync(stamp) && readFileSync(stamp, 'utf8') === pin.sha256) {
    console.log(`pdfium ${RELEASE} (${target}) is current in ${out}`)
    return
  }

  const response = await fetch(`${BASE}/${pin.archive}`)
  if (!response.ok) throw new Error(`${pin.archive}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== pin.sha256) {
    throw new Error(`${pin.archive}: sha256 ${digest} does not match the pin ${pin.sha256}`)
  }

  const work = mkdtempSync(join(tmpdir(), 'memry-pdfium-'))
  try {
    const archive = join(work, pin.archive)
    writeFileSync(archive, bytes)
    // bsdtar on macOS and Windows, GNU tar on Linux: both read gzip with -z.
    execFileSync('tar', ['-xzf', pin.archive], { cwd: work, stdio: 'inherit' })
    mkdirSync(out, { recursive: true })
    copyFileSync(join(work, pin.library), library)
    copyFileSync(join(work, 'LICENSE'), join(out, 'LICENSE'))
    writeFileSync(stamp, pin.sha256)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  console.log(`pdfium ${RELEASE} (${target}) -> ${library}`)
}

await main()
