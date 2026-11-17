#!/usr/bin/env node
// Builds what a release bundle adds to the app, for `tauri build --config src-tauri/tauri.release.conf.json`:
// the release-profile sidecars as `src-tauri/binaries/<name>-<triple>[.exe]` (Tauri's `externalBin`
// naming), and the pinned pdfium library and its LICENSE in `src-tauri/binaries/pdfium/`. It checks
// the committed English OCR data against the sha256 the app checks at run time.
//
//   node apps/desktop-tauri/scripts/build-sidecars.mjs --target <triple>
//
// The worker links ONNX Runtime statically, so every target but macOS arm64 needs
// `ORT_LIB_LOCATION` (crates/AGENTS.md, ONNX Runtime), and Tesseract, built with cmake from the
// sources `scripts/fetch-tesseract-sources.mjs` pins.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const TAURI_DIR = join(ROOT, 'apps/desktop-tauri/src-tauri')
const OCR_SOURCE = join(ROOT, 'crates/memry-desktop/src/services/file_text/ocr.rs')
export const OCR_DATA = join(TAURI_DIR, 'resources/tessdata/eng.traineddata.gz')

/**
 * The Rust binaries bundled through `externalBin`, by crate and bin name. Step 35 adds
 * `memrynote-cli` here; Step 29's `memry-eventkit` (macOS) is not a cargo bin and gets its own
 * build step.
 */
export const SIDECARS = [{ crate: 'memry-ml-worker', bin: 'memry-ml-worker' }]

/** A Rust target triple to the `scripts/fetch-pdfium.mjs --target` of its pdfium build. */
const PDFIUM_TARGETS = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-pc-windows-msvc': 'win32-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64'
}

export function pdfiumTarget(triple) {
  const target = PDFIUM_TARGETS[triple]
  if (!target) {
    throw new Error(`no release target ${triple}; known: ${Object.keys(PDFIUM_TARGETS).join(', ')}`)
  }
  return target
}

const exe = (triple) => (triple.includes('windows') ? '.exe' : '')

/** The file `externalBin: ["binaries/<bin>"]` expects for `triple`. */
export const sidecarFile = (bin, triple) => `${bin}-${triple}${exe(triple)}`

/** `BUNDLED_PACK_SHA256` of `file_text/ocr.rs`, the one pin of the English data. */
export function bundledPackSha256(ocrSource) {
  const pin = /BUNDLED_PACK_SHA256: &str =\s*"([0-9a-f]{64})"/.exec(ocrSource)
  if (!pin) throw new Error('ocr.rs declares no BUNDLED_PACK_SHA256')
  return pin[1]
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status ?? result.signal}`)
}

function main(argv) {
  const index = argv.indexOf('--target')
  const triple = index === -1 ? undefined : argv[index + 1]
  if (!triple) throw new Error('usage: build-sidecars.mjs --target <triple>')
  const pdfium = pdfiumTarget(triple)

  const pinned = bundledPackSha256(readFileSync(OCR_SOURCE, 'utf8'))
  const actual = createHash('sha256').update(readFileSync(OCR_DATA)).digest('hex')
  if (actual !== pinned) throw new Error(`${OCR_DATA} has sha256 ${actual}, ocr.rs pins ${pinned}`)

  run(process.execPath, ['scripts/fetch-tesseract-sources.mjs'])
  const binaries = join(TAURI_DIR, 'binaries')
  mkdirSync(binaries, { recursive: true })
  for (const { crate, bin } of SIDECARS) {
    run('cargo', [
      'build',
      '--manifest-path',
      'crates/Cargo.toml',
      '-p',
      crate,
      '--bin',
      bin,
      '--release',
      '--target',
      triple
    ])
    const built = join(ROOT, 'crates/target', triple, 'release', `${bin}${exe(triple)}`)
    copyFileSync(built, join(binaries, sidecarFile(bin, triple)))
  }

  // A fresh dir per build, so a library of another target or a fetch stamp never ships.
  const staged = join(binaries, 'pdfium')
  const fetched = mkdtempSync(join(tmpdir(), 'memry-release-pdfium-'))
  try {
    run(process.execPath, ['scripts/fetch-pdfium.mjs', '--target', pdfium, '--out', fetched])
    rmSync(staged, { recursive: true, force: true })
    mkdirSync(staged)
    for (const name of readdirSync(fetched).filter((entry) => !entry.startsWith('.'))) {
      copyFileSync(join(fetched, name), join(staged, name))
    }
  } finally {
    rmSync(fetched, { recursive: true, force: true })
  }
  console.log(`sidecars and pdfium for ${triple} in ${binaries}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
