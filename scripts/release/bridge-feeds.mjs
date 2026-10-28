// electron-updater bridge feeds: latest-mac.yml, latest-linux.yml, latest.yml.
// Same layout electron-builder wrote for v2026-10-15: version, files[] (url, sha512 as base64,
// size), top-level path and sha512 of the primary file, releaseDate. No blockMapSize key and no
// blockmap assets: electron-updater logs the missing blockmap and downloads the full file.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Darwin 22 is macOS 13. electron-updater 6.6.2+ skips a release whose key is greater than
// os.release(), so macOS 12 (Darwin 21) installs stay on Electron.
export const MIN_MAC_DARWIN = '22.0.0'

/** `{ url, sha512, size }` for the exact bytes that get uploaded (hash after signing). */
export function describeBytes(url, bytes) {
  return {
    url,
    sha512: createHash('sha512').update(bytes).digest('base64'),
    size: bytes.byteLength
  }
}

export function describeFile(filePath, url = path.basename(filePath)) {
  return describeBytes(url, readFileSync(filePath))
}

function renderFeed({ version, files, releaseDate, minimumSystemVersion }) {
  if (!version) {
    throw new Error('version is required')
  }
  if (files.length === 0) {
    throw new Error('files must not be empty')
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(releaseDate)) {
    throw new Error(`releaseDate must be an ISO string with milliseconds, got "${releaseDate}"`)
  }
  for (const file of files) {
    if (!file.url || !file.sha512 || !Number.isInteger(file.size) || file.size <= 0) {
      throw new Error(`File entry is incomplete: ${JSON.stringify(file)}`)
    }
  }

  const lines = [`version: ${version}`, 'files:']
  for (const file of files) {
    lines.push(`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`)
  }
  lines.push(`path: ${files[0].url}`, `sha512: ${files[0].sha512}`, `releaseDate: '${releaseDate}'`)
  if (minimumSystemVersion) {
    lines.push(`minimumSystemVersion: ${minimumSystemVersion}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Entries in the order electron-builder merged them: arm64 zip, arm64 dmg, x64 zip, x64 dmg.
 * The dmg entries are optional (a rehearsal publishes the zips only).
 */
export function buildLatestMacYml({ version, releaseDate, arm64Zip, arm64Dmg, x64Zip, x64Dmg }) {
  if (!arm64Zip || !x64Zip) {
    throw new Error('Both the arm64 and the x64 zip are required')
  }
  const files = [arm64Zip, arm64Dmg, x64Zip, x64Dmg].filter(Boolean)
  return renderFeed({ version, files, releaseDate, minimumSystemVersion: MIN_MAC_DARWIN })
}

/** `files` is the ordered list; `path` and `sha512` come from the first entry. */
export function buildLatestLinuxYml({ version, releaseDate, files }) {
  return renderFeed({ version, files, releaseDate })
}

/** One entry: `MemryNote-V-setup.exe`, a byte copy of the signed `MemryNote-Setup-win-x64.exe`. */
export function buildLatestYml({ version, releaseDate, setup }) {
  return renderFeed({ version, files: [setup], releaseDate })
}

export function setupExeName(version) {
  return `MemryNote-${version}-setup.exe`
}
