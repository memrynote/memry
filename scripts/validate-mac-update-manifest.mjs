#!/usr/bin/env node
// Fail-fast validator for the merged macOS auto-update manifest (latest-mac.yml).
//
// The publish-release workflow merges the two per-arch manifests
// (latest-mac-arm64.yml + latest-mac-x64.yml) into a single latest-mac.yml so
// that both x64 and arm64 clients auto-update. electron-updater's MacUpdater
// selects the download whose `url` includes 'arm64' for arm64 hosts and the
// non-arm64 zip for x64 hosts, so BOTH arch zips must survive the merge with a
// well-formed url + sha512. A silently dropped arch = that arch stops updating.
//
// Dependency-free (Node builtins only) so it runs in CI without an install and
// can be invoked by hand against any merged manifest.
//
// Usage:
//   node scripts/validate-mac-update-manifest.mjs [path-to-latest-mac.yml]
//   ASSET_DIR=/path/to/assets node scripts/validate-mac-update-manifest.mjs
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const sha512Pattern = /^[A-Za-z0-9+/=]{80,}$/

export function parseManifest(text) {
  const manifest = { version: undefined, files: [] }
  let inFiles = false
  let current = null

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '') {
      continue
    }

    const indent = rawLine.length - rawLine.trimStart().length

    if (indent === 0) {
      inFiles = false
      current = null
      const match = rawLine.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
      if (!match) {
        continue
      }
      if (match[1] === 'files') {
        inFiles = true
        continue
      }
      if (match[1] === 'version') {
        manifest.version = stripValue(match[2])
      }
      continue
    }

    if (!inFiles) {
      continue
    }

    const trimmed = rawLine.trimStart()
    if (trimmed.startsWith('- ')) {
      current = {}
      manifest.files.push(current)
      addPair(current, trimmed.slice(2))
      continue
    }
    if (current) {
      addPair(current, trimmed)
    }
  }

  return manifest
}

export function validateManifest(manifest) {
  const errors = []

  if (!manifest.version) {
    errors.push('Manifest is missing a version.')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 2) {
    errors.push(`Manifest files[] must list both arch zips, found ${manifest.files?.length ?? 0}.`)
  }

  const zips = (manifest.files || []).filter(
    (entry) => typeof entry.url === 'string' && entry.url.endsWith('.zip')
  )
  const armZip = zips.find((entry) => entry.url.includes('arm64'))
  const x64Zip = zips.find((entry) => !entry.url.includes('arm64'))

  if (!armZip) {
    errors.push('Missing arm64 macOS zip entry (url including "arm64").')
  }
  if (!x64Zip) {
    errors.push('Missing x64 macOS zip entry (non-arm64 zip url).')
  }

  for (const [arch, entry] of [
    ['arm64', armZip],
    ['x64', x64Zip]
  ]) {
    if (!entry) {
      continue
    }
    if (!entry.url || /\s/.test(entry.url)) {
      errors.push(`${arch} entry has a malformed url: ${entry.url ?? '<missing>'}`)
    }
    if (!entry.sha512 || !sha512Pattern.test(entry.sha512)) {
      errors.push(`${arch} entry has a malformed sha512: ${entry.sha512 ?? '<missing>'}`)
    }
  }

  if (armZip?.sha512 && x64Zip?.sha512 && armZip.sha512 === x64Zip.sha512) {
    errors.push('arm64 and x64 entries share the same sha512 — one arch was duplicated.')
  }

  return { armZip, errors, x64Zip }
}

function stripValue(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function addPair(target, segment) {
  const match = segment.match(/^([A-Za-z0-9_]+):\s*(.*)$/)
  if (!match) {
    return
  }
  target[match[1]] = stripValue(match[2])
}

function resolveManifestPath(argv) {
  if (argv[0]) {
    return argv[0]
  }
  if (process.env.ASSET_DIR) {
    return path.join(process.env.ASSET_DIR, 'latest-mac.yml')
  }
  return path.resolve('latest-mac.yml')
}

function fail(errors) {
  const inActions = Boolean(process.env.GITHUB_ACTIONS)
  for (const error of errors) {
    console.error(inActions ? `::error::${error}` : `error: ${error}`)
  }
  process.exit(1)
}

function main() {
  const manifestPath = resolveManifestPath(process.argv.slice(2))

  if (!existsSync(manifestPath)) {
    fail([`Merged manifest not found: ${manifestPath}`])
  }

  const text = readFileSync(manifestPath, 'utf8')
  if (!text.trim()) {
    fail([`Merged manifest is empty: ${manifestPath}`])
  }

  const manifest = parseManifest(text)
  const { armZip, errors, x64Zip } = validateManifest(manifest)

  if (errors.length > 0) {
    fail(errors)
  }

  console.log(`Validated ${manifestPath}`)
  console.log(`  version: ${manifest.version}`)
  console.log(`  arm64:   ${armZip.url} (sha512 ${armZip.sha512.slice(0, 12)}…)`)
  console.log(`  x64:     ${x64Zip.url} (sha512 ${x64Zip.sha512.slice(0, 12)}…)`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
