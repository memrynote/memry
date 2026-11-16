#!/usr/bin/env node
/**
 * Downloads the Leptonica and Tesseract sources that `crates/memry-ml-worker/build.rs` builds with
 * cmake and links statically into the worker (#3542, R1). Each zip's sha256 is pinned below; a
 * mismatch fails without writing anything. Cargo itself never touches the network for them.
 *
 *   node scripts/fetch-tesseract-sources.mjs [--root <dir>]
 *
 * Writes `<root>/src/leptonica-1.87.0` and `<root>/src/tesseract-5.5.2`, each with a `.pin` file
 * holding its zip's sha256. `<root>` is `MEMRY_TESSERACT_DIR`, else a cache dir shared by every
 * checkout of this repo (`defaultRoot` below, the same rule as build.rs), so the C++ is built once
 * per machine and target. A second run with the same pins downloads nothing. Needs cmake, which the
 * build needs too; it extracts the zips.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The source trees build.rs expects, by folder name under `<root>/src`. */
export const PINS = {
  'leptonica-1.87.0': {
    url: 'https://github.com/DanBloomberg/leptonica/archive/refs/tags/1.87.0.zip',
    sha256: '2cfb7ebe6036f3d017280fa9a000c9699ab28be8dff8be8e2e948e2c79917eda'
  },
  'tesseract-5.5.2': {
    url: 'https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.2.zip',
    sha256: '449621680d529fde7a2d079805dce4687fef0a692c272be3ce431c30c69162d2'
  }
}

/** Keep in step with `default_root` in `crates/memry-ml-worker/build.rs`. */
export function defaultRoot() {
  if (process.env.MEMRY_TESSERACT_DIR) return resolve(process.env.MEMRY_TESSERACT_DIR)
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'memry-tesseract')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'memry-tesseract')
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'memry-tesseract')
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function fetchOne(srcDir, name, pin) {
  const dest = join(srcDir, name)
  const stamp = join(dest, '.pin')
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === pin.sha256) {
    console.log(`${name} is current in ${dest}`)
    return
  }
  const response = await fetch(pin.url)
  if (!response.ok) throw new Error(`${pin.url}: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== pin.sha256) {
    throw new Error(`${name}: sha256 ${digest} does not match the pin ${pin.sha256}`)
  }
  mkdirSync(srcDir, { recursive: true })
  const work = mkdtempSync(join(srcDir, `.${name}-`))
  try {
    writeFileSync(join(work, 'source.zip'), bytes)
    execFileSync('cmake', ['-E', 'tar', 'xf', 'source.zip'], { cwd: work, stdio: 'inherit' })
    // GitHub's archive holds one folder, `<repo>-<tag>`; it becomes `<root>/src/<name>`.
    const tree = join(work, name)
    if (!existsSync(tree)) throw new Error(`${name}: the zip has no ${name}/ folder`)
    writeFileSync(join(tree, '.pin'), pin.sha256)
    rmSync(dest, { recursive: true, force: true })
    renameSync(tree, dest)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  console.log(`${name} -> ${dest}`)
}

async function main() {
  const root = resolve(option('--root') ?? defaultRoot())
  const srcDir = join(root, 'src')
  for (const [name, pin] of Object.entries(PINS)) await fetchOne(srcDir, name, pin)
}

await main()
