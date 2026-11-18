// What `pnpm release` (scripts/release.mjs) does with the CI artifacts on the Mac, minus the vpk
// and osslsigncode runs: which vpk outputs become release assets, the bridge step, and the checks
// that hold the upload back.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync
} from 'node:fs'
import path from 'node:path'

import { BRIDGES_WIN_LINUX, describeFile, setupExeName, writeBridgeFeeds } from './bridge-feeds.mjs'
import { checkAssetSet, releaseAssets } from './required-assets.mjs'
import { assetNames } from './vpk-args.mjs'
import { BOOTSTRAPPER_PATH } from './webview2-bootstrapper.mjs'

const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'))

/**
 * Unpacks a Windows payload zip into `packDir` after checking it is the zip the CI build checked
 * (`sha256` from release-metadata.json). The zip comes from PowerShell's `Compress-Archive`;
 * Info-ZIP turns a Windows-made zip's `\` separators into directories, and any name still holding
 * one fails the unpack instead of packing a flat `pdfium\pdfium.dll`.
 */
export function unpackPayload(zip, packDir, sha256) {
  const actual = createHash('sha256').update(readFileSync(zip)).digest('hex')
  if (actual !== sha256) {
    throw new Error(
      `${path.basename(zip)} has sha256 ${actual}; release-metadata.json records ${sha256}. It is not the zip the build checked.`
    )
  }
  // Exit 1 is a warning, such as the separator conversion; the name check below is the gate.
  const result = spawnSync('unzip', ['-q', zip, '-d', packDir], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === null || result.status > 1) {
    throw new Error(`unzip ${path.basename(zip)} exited with ${result.status}: ${result.stderr}`)
  }
  const flattened = readdirSync(packDir, { recursive: true }).filter((name) => name.includes('\\'))
  if (flattened.length > 0) {
    throw new Error(
      `${path.basename(zip)} unpacked to names holding a backslash: ${flattened.join(', ')}`
    )
  }
}

/**
 * The release assets among vpk's outputs for `target`. vpk's output dir also holds the previous
 * full package the delta was built against, `assets.<channel>.json` and its log; none of them ships.
 */
export function packReleaseAssets(target, version, outputNames) {
  const names = assetNames(target, version)
  return [names.setup, names.full, names.delta, names.releases, names.legacyReleases].filter(
    (name) => outputNames.includes(name)
  )
}

/** Copies the release assets of a finished `target` pack into `assetDir` and returns their names. */
export function stagePackOutputs(target, version, outputDir, assetDir) {
  const staged = packReleaseAssets(target, version, readdirSync(outputDir))
  for (const name of staged) copyFileSync(path.join(outputDir, name), path.join(assetDir, name))
  return staged
}

/**
 * While the release bridges Electron's Windows installs, copies the signed x64 Setup to
 * `MemryNote-V-setup.exe`, the file `latest.yml` names. Then writes every bridge feed from the
 * staged bytes and returns the feed names.
 */
export function bridgeRelease(assetDir, version) {
  if (BRIDGES_WIN_LINUX) {
    copyFileSync(
      path.join(assetDir, assetNames('win-x64', version).setup),
      path.join(assetDir, setupExeName(version))
    )
  }
  return writeBridgeFeeds(assetDir, { version })
}

/** Each missing and each unexpected file of `assetDir` against the full release asset set. */
export function releaseSetProblems(assetDir, version) {
  const names = readdirSync(assetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  const { missing, unexpected } = checkAssetSet(names, releaseAssets(version))
  return [
    ...missing.map((name) => `missing: ${name}`),
    ...unexpected.map((name) => `unexpected: ${name}`)
  ]
}

/** The keys bridge-feeds.mjs writes, read back line by line. */
function parseFeed(text) {
  const feed = { files: [] }
  for (const line of text.split('\n')) {
    const entry = /^ {2}- url: (.+)$/.exec(line)
    const field = /^ {4}(sha512|size): (.+)$/.exec(line)
    const top = /^(version|path|sha512): (.+)$/.exec(line)
    if (entry) feed.files.push({ url: entry[1] })
    else if (field && feed.files.length > 0) {
      feed.files.at(-1)[field[1]] = field[1] === 'size' ? Number(field[2]) : field[2]
    } else if (top) feed[top[1]] = top[2]
  }
  return feed
}

/**
 * Every way the bridge feeds in `assetDir` disagree with the staged files: electron-updater
 * refuses a download whose bytes do not match the listed `sha512` and `size`.
 */
export function feedProblems(assetDir, version) {
  const problems = []
  const feeds = readdirSync(assetDir).filter((name) => /^latest(-mac|-linux)?\.yml$/.test(name))
  for (const feed of feeds) {
    const {
      files,
      path: primary,
      sha512,
      version: listed
    } = parseFeed(readFileSync(path.join(assetDir, feed), 'utf8'))
    if (listed !== version) problems.push(`${feed}: version ${listed}, expected ${version}`)
    if (files.length === 0) problems.push(`${feed}: lists no file`)
    for (const entry of files) {
      const file = path.join(assetDir, entry.url)
      if (!existsSync(file)) {
        problems.push(`${feed}: ${entry.url} is not staged`)
        continue
      }
      const actual = describeFile(file)
      if (actual.sha512 !== entry.sha512) problems.push(`${feed}: sha512 of ${entry.url} differs`)
      if (actual.size !== entry.size) problems.push(`${feed}: size of ${entry.url} differs`)
    }
    if (files[0] && (primary !== files[0].url || sha512 !== files[0].sha512)) {
      problems.push(`${feed}: path and sha512 do not name ${files[0].url}`)
    }
  }
  return problems
}

/** Whether `header` (the first bytes of a file) starts a PE image: `MZ`, then `PE\0\0` at e_lfanew. */
export function isPortableExecutable(header) {
  if (header.length < 0x40 || header.readUInt16LE(0) !== 0x5a4d) return false
  const offset = header.readUInt32LE(0x3c)
  return offset + 4 <= header.length && header.readUInt32LE(offset) === 0x00004550
}

function readHeader(file) {
  const fd = openSync(file, 'r')
  try {
    const header = Buffer.alloc(4096)
    return header.subarray(0, readSync(fd, header, 0, header.length, 0))
  } finally {
    closeSync(fd)
  }
}

/** The PE files under `dir`, as `/`-separated paths relative to it, sorted. */
export function listPortableExecutables(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => isPortableExecutable(readHeader(file)))
    .map((file) => path.relative(dir, file).split(path.sep).join('/'))
    .toSorted()
}

/**
 * The PE files a Windows pack must hold, relative to the app dir: the executables and DLL
 * resources of `payload-manifest.json` and the WebView2 bootstrapper. A walk that finds fewer
 * signed nothing that matters, so it must not pass.
 */
export function requiredWindowsBinaries(
  manifest = readJson(new URL('./payload-manifest.json', import.meta.url))
) {
  const { executables, resources } = manifest.platforms.windows
  return [
    ...executables,
    ...resources.filter((name) => /\.(dll|exe)$/i.test(name)),
    BOOTSTRAPPER_PATH.split(path.sep).join('/')
  ]
}

/**
 * Who must have signed each PE file of a pack: `certum` for ours, and the listed signer for the
 * names in `third-party-signed.json`, which sign-windows-binary.sh never signs. Throws when a
 * required binary is absent or a listed signer has no check here.
 */
export function signaturePlan(
  peFiles,
  {
    thirdParty = readJson(new URL('./third-party-signed.json', import.meta.url)),
    required = requiredWindowsBinaries()
  } = {}
) {
  const missing = required.filter((name) => !peFiles.includes(name))
  if (missing.length > 0) throw new Error(`The pack holds no ${missing.join(', ')}`)
  const signers = new Map(thirdParty.map(({ name, signer }) => [name, signer]))
  return peFiles.map((file) => {
    const signer = signers.get(path.posix.basename(file)) ?? 'certum'
    if (signer !== 'certum' && signer !== 'Microsoft Corporation') {
      throw new Error(`No signature check for ${file}, signed by ${signer}`)
    }
    return { file, signer }
  })
}
