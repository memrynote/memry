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

// Whether a release also bridges Electron's Windows and Linux installs: `latest.yml`, its
// `MemryNote-V-setup.exe` copy and `latest-linux.yml`. Step 44 (#3561) owns the rule that flips
// it. `latest-mac.yml` has no flag: it is always published.
export const BRIDGES_WIN_LINUX = true

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

function renderFeed({ version, files, releaseDate, minimumSystemVersion, stagingPercentage }) {
  if (!version) {
    throw new Error('version is required')
  }
  if (files.length === 0) {
    throw new Error('files must not be empty')
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(releaseDate)) {
    throw new Error(`releaseDate must be an ISO string with milliseconds, got "${releaseDate}"`)
  }
  if (
    stagingPercentage !== undefined &&
    !(Number.isInteger(stagingPercentage) && stagingPercentage >= 1 && stagingPercentage <= 100)
  ) {
    throw new Error(`stagingPercentage must be an integer from 1 to 100, got ${stagingPercentage}`)
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
  // electron-updater 6.7.3 offers the release to that share of installs, bucketed by `.updaterId`.
  if (stagingPercentage !== undefined) {
    lines.push(`stagingPercentage: ${stagingPercentage}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Entries in the order electron-builder merged them: arm64 zip, arm64 dmg, x64 zip, x64 dmg.
 * The dmg entries are optional (a rehearsal publishes the zips only).
 */
export function buildLatestMacYml({
  version,
  releaseDate,
  arm64Zip,
  arm64Dmg,
  x64Zip,
  x64Dmg,
  stagingPercentage
}) {
  if (!arm64Zip || !x64Zip) {
    throw new Error('Both the arm64 and the x64 zip are required')
  }
  const files = [arm64Zip, arm64Dmg, x64Zip, x64Dmg].filter(Boolean)
  return renderFeed({
    version,
    files,
    releaseDate,
    minimumSystemVersion: MIN_MAC_DARWIN,
    stagingPercentage
  })
}

/**
 * The AppImage first, so `path` and `sha512` name it, then the deb, which shipped `.deb` installs
 * update from. The deb is optional (a rehearsal builds none).
 */
export function buildLatestLinuxYml({ version, releaseDate, appImage, deb, stagingPercentage }) {
  if (!appImage) {
    throw new Error('The AppImage entry is required')
  }
  const files = [appImage, deb].filter(Boolean)
  return renderFeed({ version, files, releaseDate, stagingPercentage })
}

/** One entry: `MemryNote-V-setup.exe`, a byte copy of the signed `MemryNote-Setup-win-x64.exe`. */
export function buildLatestYml({ version, releaseDate, setup, stagingPercentage }) {
  return renderFeed({ version, files: [setup], releaseDate, stagingPercentage })
}

/**
 * The bridge feeds of a release, by file name. `mac` holds the `buildLatestMacYml` entries,
 * `linux` the `buildLatestLinuxYml` ones, `setup` the `MemryNote-V-setup.exe` entry (absent when a
 * rehearsal builds no Windows). `latest-mac.yml` is always written; the other two follow
 * `bridgesWinLinux`.
 */
export function buildBridgeFeeds({
  version,
  releaseDate,
  mac,
  linux,
  setup,
  stagingPercentage,
  bridgesWinLinux = BRIDGES_WIN_LINUX
}) {
  if (!mac) {
    throw new Error('latest-mac.yml is always published: the mac entries are required')
  }
  const common = { version, releaseDate, stagingPercentage }
  const feeds = { 'latest-mac.yml': buildLatestMacYml({ ...common, ...mac }) }
  if (!bridgesWinLinux) return feeds
  feeds['latest-linux.yml'] = buildLatestLinuxYml({ ...common, ...linux })
  if (setup) feeds['latest.yml'] = buildLatestYml({ ...common, setup })
  return feeds
}

export function setupExeName(version) {
  return `MemryNote-${version}-setup.exe`
}
