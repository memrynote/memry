#!/usr/bin/env node
// Runs `vpk pack` for one target with the argument list of vpk-args.mjs.
// Usage: node scripts/release/vpk-pack.mjs <target> --version V --pack-dir D --output-dir O
//        [--release-notes P] [--delta None|BestSpeed|BestSize] [--icon P] [--sign-template T]
//        [--identity I --entitlements P --notary-profile N --keychain K]
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { isMain } from './is-main.mjs'
import { assertNoRedist } from './pe-imports.mjs'
import { buildPackArgs, publishedName, TARGETS } from './vpk-args.mjs'
import { assertBootstrapperPacked } from './webview2-bootstrapper.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')

/** The humanized notes of a release, as `pnpm release:humanize` writes them. */
export function releaseNotesPath(version) {
  return path.join(repoRoot, 'release-notes', `${version}.md`)
}

/**
 * Throws when `packDir` cannot become a `target` pack: a Windows one ships the pinned WebView2
 * bootstrapper and an exe that needs no Visual C++ redistributable. `pin` defaults to the
 * committed one (`webview2-bootstrapper.json`).
 */
export function assertPackable(target, packDir, pin) {
  if (!target.startsWith('win-')) return
  assertBootstrapperPacked(packDir, pin)
  assertNoRedist(path.join(packDir, TARGETS[target].mainExe))
}

/**
 * Renames vpk's outputs in `outputDir` to their published names, and the entries of vpk's
 * `assets.<channel>.json` index with them, so the index names the files on disk.
 */
export function renameToPublished(outputDir) {
  for (const name of readdirSync(outputDir)) {
    const file = path.join(outputDir, name)
    const published = publishedName(name)
    if (published !== name) renameSync(file, path.join(outputDir, published))
    if (/^assets\..+\.json$/.test(name)) {
      const entries = JSON.parse(readFileSync(file, 'utf8'))
      const renamed = entries.map((entry) => ({
        ...entry,
        RelativeFileName: publishedName(entry.RelativeFileName)
      }))
      writeFileSync(file, JSON.stringify(renamed))
    }
  }
}

export function parsePackCli(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      version: { type: 'string' },
      'pack-dir': { type: 'string' },
      'output-dir': { type: 'string' },
      'release-notes': { type: 'string' },
      delta: { type: 'string' },
      icon: { type: 'string' },
      'sign-template': { type: 'string' },
      identity: { type: 'string' },
      entitlements: { type: 'string' },
      'notary-profile': { type: 'string' },
      keychain: { type: 'string' }
    }
  })
  return {
    target: positionals[0],
    options: {
      version: values.version,
      packDir: values['pack-dir'],
      outputDir: values['output-dir'],
      releaseNotes: values['release-notes'] ?? releaseNotesPath(values.version),
      delta: values.delta,
      iconPath: values.icon,
      signTemplate: values['sign-template'],
      identity: values.identity,
      entitlements: values.entitlements,
      notaryProfile: values['notary-profile'],
      keychain: values.keychain
    }
  }
}

if (isMain(import.meta)) {
  const { target, options } = parsePackCli(process.argv.slice(2))
  assertPackable(target, options.packDir)
  if (!existsSync(options.releaseNotes)) {
    throw new Error(
      `No release notes at ${options.releaseNotes}. Run pnpm release:humanize, or pass --release-notes.`
    )
  }
  const args = buildPackArgs(target, options)
  console.log(`vpk ${args.join(' ')}`)
  const result = spawnSync(process.env.VPK_BIN ?? 'vpk', args, { stdio: 'inherit' })
  if (result.status === 0) renameToPublished(options.outputDir)
  process.exit(result.status ?? 1)
}
