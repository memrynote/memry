#!/usr/bin/env node
// Checks a staged release payload against payload-manifest.json.
// Usage: node scripts/release/assert-payload.mjs <payload-dir> <windows|macos|linux>
//
// The payload dir is the Windows pack dir, the macOS .app or the Linux AppDir. The check fails when
// a file of the manifest is missing; when ONNX Runtime, DirectML, Tesseract or Leptonica ships as a
// shared library (the worker links all four statically); when a model file ships (whisper and
// embedding models download on demand); when a file exceeds the manifest's size cap; when the main
// binary or a sidecar links one of those libraries or, on Windows, the Visual C++
// redistributable; or when the manifest lists other files than the release config bundles.
import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { isMain } from './is-main.mjs'
import { peImports, redistImports } from './pe-imports.mjs'
import { readReleaseConfig } from './tauri-config.mjs'

export const MANIFEST = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'payload-manifest.json'), 'utf8')
)

const SHARED_LIBRARY = /\.(dll|dylib|so)(\.\d+)*$/i
const STATIC_ONLY = /onnxruntime|directml|tesseract|lept/i
const MODEL_FILE = /^ggml-.*\.bin$|^model_q4\.onnx$/i
// A listing without the system C library is empty or failed and would pass every check below.
const SYSTEM_LIBRARY = /libSystem|libc\.so|kernel32\.dll/i

const join = (...parts) => path.posix.join(...parts.filter(Boolean))
const exeSuffix = (platform) => (platform === 'windows' ? '.exe' : '')
const resourceTarget = (target) => target.replace(/\/+$/, '')
const under = (file, target) => file === target || file.startsWith(`${target}/`)

/** Differences between the manifest's files for `platform` and what the release `config` bundles. */
export function manifestDrift(platform, manifest, config) {
  const entry = manifest.platforms[platform]
  const suffix = exeSuffix(platform)
  const errors = []
  const expectedExecutables = [
    `${config.mainBinaryName}${suffix}`,
    ...(config.bundle?.externalBin ?? []).map((bin) => `${path.posix.basename(bin)}${suffix}`)
  ]
  const missing = expectedExecutables.filter((name) => !entry.executables.includes(name))
  const extra = entry.executables.filter((name) => !expectedExecutables.includes(name))
  if (missing.length > 0) errors.push(`${platform}: the manifest lacks executables ${missing}`)
  if (extra.length > 0) errors.push(`${platform}: the config bundles no executables ${extra}`)

  const resources = config.bundle?.resources ?? []
  const targets = (Array.isArray(resources) ? resources : Object.values(resources)).map(
    resourceTarget
  )
  for (const target of targets) {
    if (!entry.resources.some((file) => under(file, target))) {
      errors.push(`${platform}: the manifest lists no file of the bundled resource ${target}`)
    }
  }
  for (const file of entry.resources) {
    if (!targets.some((target) => under(file, target))) {
      errors.push(`${platform}: the config bundles no resource ${file}`)
    }
  }
  return errors
}

function listFiles(root, rel = '') {
  return readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((dirent) => {
    const child = join(rel, dirent.name)
    return dirent.isDirectory() ? listFiles(root, child) : [child]
  })
}

/** The libraries `file` links: otool on macOS, ldd on Linux, the PE import tables on Windows. */
export function listLinks(platform, file) {
  if (platform === 'windows') return peImports(readFileSync(file)).join('\n')
  const [command, args] = platform === 'macos' ? ['otool', ['-L']] : ['ldd', []]
  return execFileSync(command, [...args, file], { encoding: 'utf8' })
}

/** The payload's problems, and the link listing of each executable. */
export function checkPayload({ platform, root, manifest = MANIFEST, config, links }) {
  const entry = manifest.platforms[platform]
  const errors = manifestDrift(platform, manifest, config)
  const files = listFiles(root)
  const required = [
    ...entry.executables.map((name) => join(entry.binDir, name)),
    ...entry.resources.map((rel) => join(entry.resourceDir, rel))
  ]
  for (const rel of required) {
    if (!files.includes(rel)) errors.push(`missing ${rel}`)
  }
  for (const rel of files) {
    const name = path.posix.basename(rel)
    if (SHARED_LIBRARY.test(name) && STATIC_ONLY.test(name)) {
      errors.push(`${rel} is a shared ONNX Runtime, DirectML, Tesseract or Leptonica library`)
    }
    if (MODEL_FILE.test(name)) errors.push(`${rel} is a model file; models download on demand`)
    const size = lstatSync(path.join(root, rel)).size
    if (size > manifest.maxFileBytes) {
      errors.push(`${rel} is ${size} bytes, over the cap of ${manifest.maxFileBytes}`)
    }
  }

  const listings = {}
  for (const name of entry.executables) {
    const rel = join(entry.binDir, name)
    if (!files.includes(rel)) continue
    const listing = links(platform, path.join(root, rel))
    listings[rel] = listing
    if (!SYSTEM_LIBRARY.test(listing)) {
      errors.push(`${rel}: the link listing names no system C library`)
    }
    const lines = listing.split('\n')
    const banned = lines.filter((line) => STATIC_ONLY.test(path.basename(line.trim())))
    if (banned.length > 0) errors.push(`${rel} links ${banned.map((l) => l.trim()).join(', ')}`)
    if (platform === 'windows') {
      const redist = redistImports(lines.map((line) => line.trim().toLowerCase()))
      if (redist.length > 0) errors.push(`${rel} needs the VC++ redistributable: ${redist}`)
    }
  }
  return { errors, listings }
}

if (isMain(import.meta)) {
  const [root, platform] = process.argv.slice(2)
  if (!root || !platform) {
    console.error('usage: assert-payload.mjs <payload-dir> <windows|macos|linux>')
    process.exit(2)
  }
  const { errors, listings } = checkPayload({
    platform,
    root: path.resolve(root),
    config: readReleaseConfig(platform),
    links: listLinks
  })
  for (const [rel, listing] of Object.entries(listings)) {
    console.log(`== linked libraries of ${rel}\n${listing.trim()}`)
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`::error::${error}`)
    process.exit(1)
  }
  console.log(`payload ok: ${root} (${platform})`)
}
