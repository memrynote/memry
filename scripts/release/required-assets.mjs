#!/usr/bin/env node
// The asset set of a Tauri release, and the check that a staged directory holds exactly it.
// Usage: node scripts/release/required-assets.mjs <asset-dir> --version V [--set ci|release] [--list]
//   --set ci       the files the CI build jobs stage: macOS and Linux (default)
//   --set release  ci plus the Windows files the Mac packs and signs
//   --list         after a pass, print the asset names one per line (Step 42, #3559, reads them)
// Exits 1 naming every missing and every unexpected file.
import { readdirSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { BRIDGES_WIN_LINUX, setupExeName } from './bridge-feeds.mjs'
import { isMain } from './is-main.mjs'
import { assetNames } from './vpk-args.mjs'

/**
 * `{ required, optional }` names the CI build jobs stage. A delta exists only when
 * `shouldPackDelta` held for its channel, so deltas are optional. vpk's `Portable.zip` files, the
 * unversioned `MemryNote.AppImage` (the landing takes the first `.AppImage` asset), its
 * `assets.<channel>.json` indexes and payload zips are not release assets.
 */
export function ciAssets(version, { bridgesWinLinux = BRIDGES_WIN_LINUX } = {}) {
  const required = []
  const optional = []
  for (const arch of ['arm64', 'x64']) {
    const names = assetNames(`osx-${arch}`, version)
    required.push(
      `MemryNote-${version}-${arch}.dmg`,
      names.squirrelZip,
      names.full,
      names.releases,
      names.legacyReleases
    )
    optional.push(names.delta)
  }
  const linux = assetNames('linux-x64', version)
  required.push(
    linux.appImage,
    `MemryNote-${version}-amd64.deb`,
    linux.full,
    linux.releases,
    linux.legacyReleases,
    'latest-mac.yml'
  )
  optional.push(linux.delta)
  if (bridgesWinLinux) required.push('latest-linux.yml')
  return { required, optional }
}

/** `ciAssets` plus the Windows x64 and arm64 packs and, while bridging, the electron-updater feed. */
export function releaseAssets(version, { bridgesWinLinux = BRIDGES_WIN_LINUX } = {}) {
  const { required, optional } = ciAssets(version, { bridgesWinLinux })
  for (const target of ['win-x64', 'win-arm64']) {
    const names = assetNames(target, version)
    required.push(names.setup, names.full, names.releases, names.legacyReleases)
    optional.push(names.delta)
  }
  if (bridgesWinLinux) required.push(setupExeName(version), 'latest.yml')
  return { required, optional }
}

/** The names `set` requires and `names` lacks, and the names `set` does not allow. */
export function checkAssetSet(names, { required, optional }) {
  const allowed = new Set([...required, ...optional])
  return {
    missing: required.filter((name) => !names.includes(name)),
    unexpected: names.filter((name) => !allowed.has(name))
  }
}

export function runCli(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      set: { type: 'string', default: 'ci' },
      list: { type: 'boolean', default: false }
    }
  })
  const [dir] = positionals
  const sets = { ci: ciAssets, release: releaseAssets }
  if (!dir || !values.version || !sets[values.set]) {
    throw new Error(
      'usage: required-assets.mjs <asset-dir> --version V [--set ci|release] [--list]'
    )
  }
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .toSorted()
  const { missing, unexpected } = checkAssetSet(names, sets[values.set](values.version))
  if (missing.length > 0 || unexpected.length > 0) {
    const lines = [
      ...missing.map((name) => `missing: ${name}`),
      ...unexpected.map((name) => `unexpected: ${name}`)
    ]
    throw new Error(
      `${dir} is not the ${values.set} asset set of ${values.version}:\n${lines.join('\n')}`
    )
  }
  return values.list ? names : []
}

if (isMain(import.meta)) {
  try {
    for (const name of runCli(process.argv.slice(2))) console.log(name)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
