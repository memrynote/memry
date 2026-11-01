// The WebView2 bootstrapper a Windows pack ships beside Memrynote.exe. The app runs it at launch
// when the runtime is missing (`memry_desktop::updater::webview2::BOOTSTRAPPER`).
//
// What ships is pinned: webview2-bootstrapper.json names the file's own download address (where
// Microsoft's fwlink pointed when it was pinned), its SHA-256 and its size. A pack downloads that
// address and keeps the file only when both match. `--update` moves the pin: it follows the fwlink,
// keeps the new file only when its Authenticode signature verifies against the Microsoft roots in
// microsoft-roots.pem and names Microsoft Corporation as the signer, and writes the new pin for
// review. `scripts/sign-windows-binary.sh` leaves Microsoft's signature in place.
//
//   node scripts/release/webview2-bootstrapper.mjs <pack-dir>
//   node scripts/release/webview2-bootstrapper.mjs --update
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildOsslsigncodeVerifyArgs } from '../velopack-release-utils.mjs'
import { isMain } from './is-main.mjs'

export const FWLINK = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
/** Relative to the pack dir, which Velopack installs as `current\`. */
export const BOOTSTRAPPER_PATH = path.join('webview2', 'MicrosoftEdgeWebview2Setup.exe')
/** The same file inside a Velopack full package. */
export const PACKAGE_ENTRY = 'lib/app/webview2/MicrosoftEdgeWebview2Setup.exe'
const MICROSOFT_ROOTS = fileURLToPath(new URL('./microsoft-roots.pem', import.meta.url))
export const PIN_FILE = fileURLToPath(new URL('./webview2-bootstrapper.json', import.meta.url))

export function readPin(file = PIN_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** Throws unless `file` holds exactly the pinned bytes. */
export function checkPinned(file, pin = readPin()) {
  // One read: the size and the hash are of the same bytes.
  const bytes = readFileSync(file)
  if (bytes.length !== pin.size) {
    throw new Error(`${file} is ${bytes.length} bytes, the pin says ${pin.size}`)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== pin.sha256) {
    throw new Error(`${file} has SHA-256 ${sha256}, the pin says ${pin.sha256}`)
  }
}

/** Throws unless a Windows pack dir holds the pinned bootstrapper. */
export function assertBootstrapperPacked(packDir, pin = readPin()) {
  const file = path.join(packDir, BOOTSTRAPPER_PATH)
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing: a Windows pack ships the WebView2 bootstrapper (node scripts/release/webview2-bootstrapper.mjs <pack-dir>)`
    )
  }
  checkPinned(file, pin)
}

/**
 * Whether `osslsigncode verify` printed a primary signature that verified, signed by Microsoft
 * Corporation. Later signatures do not count: the bootstrapper carries a second, self-signed
 * `EdgeBuild` one that never verifies.
 */
export function isMicrosoftSigned(output) {
  const primary = (output ?? '').split(/^Signature Index: [1-9]/m)[0]
  const lines = primary.split('\n').map((line) => line.trim())
  const signers = lines.indexOf("Signer's certificate:")
  if (signers < 0 || !lines.includes('Signature verification: ok')) {
    return false
  }
  const subject = lines.slice(signers).find((line) => line.startsWith('Subject:')) ?? ''
  return subject
    .slice('Subject:'.length)
    .split(',')
    .some((part) => part.trim() === 'O=Microsoft Corporation')
}

/** Throws unless `file` is signed by Microsoft. */
export function verifyBootstrapper(file, exec = execFileSync) {
  let output
  try {
    output = exec(
      'osslsigncode',
      buildOsslsigncodeVerifyArgs({ caFile: MICROSOFT_ROOTS, filePath: file }),
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('osslsigncode is not installed (brew install osslsigncode)', {
        cause: error
      })
    }
    // A file without a valid signature exits non-zero; its output still says why.
    output = `${error.stdout ?? ''}`
  }
  if (!isMicrosoftSigned(output)) {
    throw new Error(`${file} is not signed by Microsoft Corporation`)
  }
}

/** Downloads `url` to `file`, https only, and returns the address it ended at. */
function download(url, file) {
  return execFileSync(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--proto',
      '=https',
      '--max-time',
      '300',
      '--retry',
      '3',
      '--output',
      file,
      '--write-out',
      '%{url_effective}',
      url
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  ).trim()
}

/**
 * Downloads the pinned bootstrapper into `packDir`. The download lands beside the target and is
 * renamed into place only once it matches the pin, so a pack never sees an unchecked file.
 */
export function fetchBootstrapper(packDir, { pin = readPin(), get = download } = {}) {
  const file = path.join(packDir, BOOTSTRAPPER_PATH)
  const part = `${file}.part`
  mkdirSync(path.dirname(file), { recursive: true })
  try {
    get(pin.url, part)
    checkPinned(part, pin)
    renameSync(part, file)
  } finally {
    rmSync(part, { force: true })
  }
  return file
}

/**
 * Follows the fwlink to Microsoft's current bootstrapper, checks its signature and pins it.
 * Returns the new pin.
 */
export function updatePin({
  get = download,
  verify = verifyBootstrapper,
  pinFile = PIN_FILE
} = {}) {
  const dir = path.join(os.tmpdir(), `webview2-bootstrapper-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'MicrosoftEdgeWebview2Setup.exe')
  try {
    const url = get(FWLINK, file)
    if (!url.startsWith('https://') || url === FWLINK) {
      throw new Error(`the fwlink did not lead to a file address: ${url}`)
    }
    verify(file)
    const bytes = readFileSync(file)
    const pin = {
      url,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length
    }
    writeFileSync(pinFile, `${JSON.stringify(pin, null, 2)}\n`)
    return pin
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

if (isMain(import.meta)) {
  const [arg] = process.argv.slice(2)
  if (!arg) {
    console.error('usage: webview2-bootstrapper.mjs <pack-dir> | --update')
    process.exit(2)
  }
  if (arg === '--update') {
    const pin = updatePin()
    console.log(`Pinned ${pin.url}\n  sha256 ${pin.sha256}  ${pin.size} bytes`)
  } else {
    console.log(`Fetched the pinned bootstrapper: ${fetchBootstrapper(path.resolve(arg))}`)
  }
}
