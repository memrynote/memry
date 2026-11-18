// What `pnpm release` (scripts/release.mjs) does with the CI artifacts on the Mac, minus the vpk
// and osslsigncode runs: which vpk outputs become release assets, the bridge step, and the checks
// that hold the upload back.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from 'node:fs'
import path from 'node:path'

import { BRIDGES_WIN_LINUX, describeFile, setupExeName, writeBridgeFeeds } from './bridge-feeds.mjs'
import { checkAssetSet, releaseAssets } from './required-assets.mjs'
import { assertPublishable, assetNames } from './vpk-args.mjs'
import { BOOTSTRAPPER_PATH } from './webview2-bootstrapper.mjs'

const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'))

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** A zip entry name that would land outside the dir it is unpacked into, on Windows or here. */
const escapesDir = (name) =>
  /^[\\/]/.test(name) || /^[A-Za-z]:/.test(name) || name.split(/[\\/]/).includes('..')

function runZipTool(command, args, zip) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  // Exit 1 is a warning, such as unzip's separator conversion; the checks around it are the gate.
  if (result.status === null || result.status > 1) {
    throw new Error(
      `${command} ${path.basename(zip)} exited with ${result.status}: ${result.stderr}`
    )
  }
  return result.stdout
}

/**
 * Unpacks a Windows payload zip into `packDir` after checking it is the zip the CI build checked
 * (`sha256` from release-metadata.json) and that no entry names a path outside `packDir`. Info-ZIP
 * only warns on such a name (exit 1). The zip comes from PowerShell's `Compress-Archive`; Info-ZIP
 * turns a Windows-made zip's `\` separators into directories, and any name still holding one fails
 * the unpack instead of packing a flat `pdfium\pdfium.dll`. A symbolic link fails it too: vpk
 * would pack its target from this Mac.
 */
export function unpackPayload(zip, packDir, sha256) {
  const name = path.basename(zip)
  const actual = sha256Of(zip)
  if (actual !== sha256) {
    throw new Error(
      `${name} has sha256 ${actual}; release-metadata.json records ${sha256}. It is not the zip the build checked.`
    )
  }
  const escaping = runZipTool('zipinfo', ['-1', zip], zip).split('\n').filter(escapesDir)
  if (escaping.length > 0) {
    throw new Error(`${name} holds entries outside the pack dir: ${escaping.join(', ')}`)
  }
  runZipTool('unzip', ['-q', zip, '-d', packDir], zip)
  const entries = readdirSync(packDir, { recursive: true, withFileTypes: true })
  const relative = (entry) => path.relative(packDir, path.join(entry.parentPath, entry.name))
  const links = entries.filter((entry) => entry.isSymbolicLink()).map(relative)
  if (links.length > 0) {
    throw new Error(`${name} unpacked to symbolic links: ${links.join(', ')}`)
  }
  const flattened = entries.map(relative).filter((file) => file.includes('\\'))
  if (flattened.length > 0) {
    throw new Error(`${name} unpacked to names holding a backslash: ${flattened.join(', ')}`)
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
    if (feed === 'latest.yml') problems.push(...setupCopyProblems(assetDir, version, files))
  }
  return problems
}

/**
 * NSIS installs update to the one file `latest.yml` lists: the copy of the signed x64 Setup that
 * `bridgeRelease` made. Any other file, or other bytes, would install something the Velopack feed
 * does not ship.
 */
function setupCopyProblems(assetDir, version, files) {
  const copy = setupExeName(version)
  const listed = files.map((entry) => entry.url)
  if (listed.length !== 1 || listed[0] !== copy) {
    return [`latest.yml: lists ${listed.join(', ')}, expected only ${copy}`]
  }
  const setup = assetNames('win-x64', version).setup
  const [copyFile, setupFile] = [copy, setup].map((file) => path.join(assetDir, file))
  if (!existsSync(copyFile) || !existsSync(setupFile)) return []
  return readFileSync(copyFile).equals(readFileSync(setupFile))
    ? []
    : [`latest.yml: ${copy} is not a copy of ${setup}`]
}

/** Whether `header` (the first bytes of a file) starts a PE image: `MZ`, then `PE\0\0` at e_lfanew. */
export function isPortableExecutable(header) {
  if (header.length < 0x40 || header.readUInt16LE(0) !== 0x5a4d) return false
  const offset = header.readUInt32LE(0x3c)
  return offset + 4 <= header.length && header.readUInt32LE(offset) === 0x00004550
}

// Leading bytes of the archive formats a PE file could hide in; tar's sits at offset 257.
const archiveMagic = [
  [0, 'PK\x03\x04'],
  [0, '\x1f\x8b'],
  [0, '7z\xbc\xaf\x27\x1c'],
  [0, 'MSCF'],
  [0, 'Rar!'],
  [0, '\xd0\xcf\x11\xe0'],
  [0, '\xfd7zXZ'],
  [0, 'BZh'],
  [0, '\x28\xb5\x2f\xfd'],
  [257, 'ustar']
].map(([offset, magic]) => [offset, Buffer.from(magic, 'latin1')])

// Archives the pack may ship, by path under the app dir. Each holds data, never code.
const archivesWithoutCode = new Set(['tessdata/eng.traineddata.gz'])

/** The first bytes of `file`: through the PE signature when it starts with `MZ`, else 512. */
function readHeader(file) {
  const fd = openSync(file, 'r')
  try {
    const read = (length) => {
      const bytes = Buffer.alloc(Math.min(length, fstatSync(fd).size))
      return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0))
    }
    const head = read(512)
    if (head.length < 0x40 || head.readUInt16LE(0) !== 0x5a4d) return head
    return read(head.readUInt32LE(0x3c) + 4)
  } finally {
    closeSync(fd)
  }
}

/**
 * The PE files under `dir`, as `/`-separated paths relative to it, sorted. Every file that starts
 * with `MZ` must be one: sign-windows-binary.sh skips what file(1) does not call PE, so such a file
 * would ship unsigned. An archive fails the walk unless `archivesWithoutCode` lists it, since a PE
 * file inside it is never checked.
 */
export function listPortableExecutables(dir) {
  /** @type {string[]} */
  const pe = []
  /** @type {string[]} */
  const notPe = []
  /** @type {string[]} */
  const archives = []
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    const name = path.relative(dir, file).split(path.sep).join('/')
    const header = readHeader(file)
    if (header.length >= 2 && header.readUInt16LE(0) === 0x5a4d) {
      ;(isPortableExecutable(header) ? pe : notPe).push(name)
    } else if (
      !archivesWithoutCode.has(name) &&
      archiveMagic.some(([offset, magic]) =>
        header.subarray(offset).subarray(0, magic.length).equals(magic)
      )
    ) {
      archives.push(name)
    }
  }
  if (notPe.length > 0) {
    throw new Error(
      `These files start with MZ but hold no PE signature: ${notPe.toSorted().join(', ')}`
    )
  }
  if (archives.length > 0) {
    throw new Error(
      `${dir} holds archives no signature check opens: ${archives.toSorted().join(', ')}`
    )
  }
  return pe.toSorted()
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

const draftAssetsPath = (repo, releaseId) =>
  `repos/${repo}/releases/${releaseId}/assets?per_page=100`

/** The draft's assets as GitHub lists them, every page: `{ id, name, size, digest }`. */
function listDraftAssets({ gh, releaseId, repo }) {
  return gh.json(['api', '--paginate', '--slurp', draftAssetsPath(repo, releaseId)]).flat()
}

const stagedNames = (assetDir) =>
  readdirSync(assetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .toSorted()

/**
 * Makes the draft hold the verified files of `assetDir` and nothing else. Each draft asset outside
 * that set, such as one an earlier run uploaded or one added by hand, is deleted first; the upload
 * then replaces the rest by name. `gh` is `{ json(args), run(args) }` over the gh CLI.
 */
export function uploadVerifiedAssets({ assetDir, draftTag, gh, releaseId, repo }) {
  const names = stagedNames(assetDir)
  assertPublishable(names)
  for (const asset of listDraftAssets({ gh, releaseId, repo })) {
    if (names.includes(asset.name)) continue
    console.log(`Deleting ${asset.name} from ${draftTag}: it is not in the verified set`)
    gh.run(['api', '--method', 'DELETE', `repos/${repo}/releases/assets/${asset.id}`])
  }
  console.log(`Uploading ${names.length} assets to ${draftTag}`)
  gh.run([
    'release',
    'upload',
    draftTag,
    ...names.map((name) => path.join(assetDir, name)),
    '--repo',
    repo,
    '--clobber'
  ])
}

/**
 * Every way the draft's assets differ from the verified files of `assetDir`: a missing or extra
 * name, a size, or GitHub's sha256 `digest` of the uploaded bytes. Publish refuses on any.
 */
export function draftProblems({ assetDir, gh, releaseId, repo }) {
  const remote = new Map(
    listDraftAssets({ gh, releaseId, repo }).map((asset) => [asset.name, asset])
  )
  const names = stagedNames(assetDir)
  const problems = []
  for (const name of names) {
    const asset = remote.get(name)
    if (!asset) {
      problems.push(`missing on the draft: ${name}`)
      continue
    }
    const file = path.join(assetDir, name)
    const size = statSync(file).size
    if (asset.size !== size) {
      problems.push(`${name}: size ${asset.size} on the draft, ${size} verified`)
    } else if (typeof asset.digest !== 'string') {
      problems.push(`${name}: the draft lists no sha256 digest`)
    } else if (asset.digest !== `sha256:${sha256Of(file)}`) {
      problems.push(`${name}: sha256 on the draft differs from the verified file`)
    }
  }
  for (const name of [...remote.keys()].map(String).toSorted()) {
    if (!names.includes(name)) problems.push(`unexpected on the draft: ${name}`)
  }
  return problems
}
