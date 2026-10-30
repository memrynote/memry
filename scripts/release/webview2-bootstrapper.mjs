// The WebView2 bootstrapper a Windows pack ships beside Memrynote.exe. The app runs it at launch
// when the runtime is missing (`memry_desktop::updater::webview2::BOOTSTRAPPER`). The pack step
// downloads it from Microsoft and keeps it only when its Authenticode signature verifies against
// the Microsoft roots in microsoft-roots.pem and names Microsoft Corporation as the signer.
// `scripts/sign-windows-binary.sh` leaves that signature in place.
//
//   node scripts/release/webview2-bootstrapper.mjs <pack-dir>
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildOsslsigncodeVerifyArgs } from '../velopack-release-utils.mjs'

export const BOOTSTRAPPER_URL = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
/** Relative to the pack dir, which Velopack installs as `current\`. */
export const BOOTSTRAPPER_PATH = path.join('webview2', 'MicrosoftEdgeWebview2Setup.exe')
const MICROSOFT_ROOTS = fileURLToPath(new URL('./microsoft-roots.pem', import.meta.url))

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
    // A file without a valid signature exits non-zero; its output still says why.
    output = `${error.stdout ?? ''}`
  }
  if (!isMicrosoftSigned(output)) {
    throw new Error(`${file} is not signed by Microsoft Corporation; refusing to pack it`)
  }
}

/** Downloads the bootstrapper into `packDir` and verifies it. Returns its path. */
export function fetchBootstrapper(packDir) {
  const file = path.join(packDir, BOOTSTRAPPER_PATH)
  mkdirSync(path.dirname(file), { recursive: true })
  execFileSync(
    'curl',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--retry',
      '3',
      '--output',
      file,
      BOOTSTRAPPER_URL
    ],
    { stdio: 'inherit' }
  )
  verifyBootstrapper(file)
  return file
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [packDir] = process.argv.slice(2)
  if (!packDir) {
    console.error('usage: webview2-bootstrapper.mjs <pack-dir>')
    process.exit(2)
  }
  console.log(`Verified ${fetchBootstrapper(path.resolve(packDir))}`)
}
