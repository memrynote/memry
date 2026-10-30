import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { assertPackable } from './vpk-pack.mjs'
import {
  assertBootstrapperPacked,
  BOOTSTRAPPER_PATH,
  checkPinned,
  fetchBootstrapper,
  FWLINK,
  isMicrosoftSigned,
  readPin,
  updatePin,
  verifyBootstrapper
} from './webview2-bootstrapper.mjs'

const BYTES = Buffer.from('MZ pinned bootstrapper bytes')
const PIN = {
  url: 'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/x/MicrosoftEdgeWebview2Setup.exe',
  sha256: createHash('sha256').update(BYTES).digest('hex'),
  size: BYTES.length
}
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'webview2-test-'))
const serve = (bytes) => (url, file) => {
  writeFileSync(file, bytes)
  return url
}

// `osslsigncode verify` of MicrosoftEdgeWebview2Setup.exe (fwlink 2124703, October 2026),
// trimmed to the lines the check reads, in their order.
const signer = (subject) => `Signer's certificate:
\t------------------
\tSigner #0:
\t\tSubject: ${subject}
\t\tIssuer : CN=Microsoft Code Signing PCA 2024,O=Microsoft Corporation,C=US`

const MICROSOFT = 'CN=Microsoft Corporation,O=Microsoft Corporation,L=Redmond,ST=Washington,C=US'

const output = ({ primarySubject = MICROSOFT, primary, nested }) => `PE checksum   : 001D6421

Signature Index: 0  (Primary Signature)

Message digest algorithm  : SHA256
${signer(primarySubject)}

Timestamp Server Signature verification: ok
Signature verification time: Oct 24 01:17:54 2026 GMT
Signature verification: ${primary}

Signature Index: 1

${signer('CN=EdgeBuild,O=EdgeBuild,L=Redmond,ST=Washington,C=US')}

Signature verification: ${nested}

Number of verified signatures: 2
${primary === 'ok' ? 'Succeeded' : 'Failed'}
`

test('the bootstrapper as Microsoft ships it passes', () => {
  // The nested self-signed EdgeBuild signature never verifies; only the primary one counts.
  assert.equal(isMicrosoftSigned(output({ primary: 'ok', nested: 'failed' })), true)
})

test('a primary signature that does not verify fails, whatever follows it', () => {
  assert.equal(isMicrosoftSigned(output({ primary: 'failed', nested: 'ok' })), false)
})

test('a verified signature by anyone but Microsoft fails', () => {
  for (const subject of [
    'CN=Open Source Developer Kaan Karaca,O=Open Source Developer,C=TR',
    'CN=Microsoft Corporation,O=Microsoft Corporation Ltd,C=US',
    'CN=O=Microsoft Corporation'
  ]) {
    assert.equal(
      isMicrosoftSigned(output({ primarySubject: subject, primary: 'ok', nested: 'failed' })),
      false,
      subject
    )
  }
})

test('an unsigned file or no output fails', () => {
  assert.equal(
    isMicrosoftSigned('Initialization error or unsupported input file type.\nFailed\n'),
    false
  )
  assert.equal(isMicrosoftSigned(''), false)
  assert.equal(isMicrosoftSigned(undefined), false)
})

test('a bootstrapper osslsigncode rejects is refused', () => {
  const rejected = () => {
    const error = new Error('exit 1')
    error.stdout = 'No signature found.\n\nFailed\n'
    throw error
  }
  assert.throws(
    () => verifyBootstrapper('/tmp/MicrosoftEdgeWebview2Setup.exe', rejected),
    /not signed by Microsoft/
  )
  const accepted = () => output({ primary: 'ok', nested: 'failed' })
  assert.doesNotThrow(() => verifyBootstrapper('/tmp/MicrosoftEdgeWebview2Setup.exe', accepted))
})

test('osslsigncode missing says so', () => {
  const missing = () => {
    const error = new Error('spawn osslsigncode ENOENT')
    error.code = 'ENOENT'
    throw error
  }
  assert.throws(
    () => verifyBootstrapper('/tmp/MicrosoftEdgeWebview2Setup.exe', missing),
    /osslsigncode is not installed/
  )
})

test('the committed pin names one file of Microsoft by its exact bytes', () => {
  const pin = readPin()
  assert.match(pin.url, /^https:\/\/[^/]+\.microsoft\.com\/.+\/MicrosoftEdgeWebview2Setup\.exe$/)
  assert.match(pin.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Number.isInteger(pin.size) && pin.size > 0)
})

test('only the pinned bytes pass, by size and by hash', () => {
  const dir = tmp()
  const file = path.join(dir, 'b.exe')
  writeFileSync(file, BYTES)
  assert.doesNotThrow(() => checkPinned(file, PIN))
  writeFileSync(file, Buffer.concat([BYTES, Buffer.from('x')]))
  assert.throws(() => checkPinned(file, PIN), /bytes, the pin says/)
  writeFileSync(file, Buffer.from(BYTES).fill(0x41, 3))
  assert.throws(() => checkPinned(file, PIN), /SHA-256 [0-9a-f]+, the pin says/)
})

test('a pack gets the pinned file from the pinned address, and nothing else lands', () => {
  const packDir = tmp()
  const asked = []
  const get = (url, file) => {
    asked.push(url)
    return serve(BYTES)(url, file)
  }
  const file = fetchBootstrapper(packDir, { pin: PIN, get })
  assert.deepEqual(asked, [PIN.url])
  assert.equal(file, path.join(packDir, BOOTSTRAPPER_PATH))
  assert.doesNotThrow(() => assertBootstrapperPacked(packDir, PIN))

  // Microsoft changed the file behind the address: no file, and no part file either.
  const other = tmp()
  assert.throws(
    () => fetchBootstrapper(other, { pin: PIN, get: serve(Buffer.from('MZ other')) }),
    /the pin says/
  )
  assert.deepEqual(readdirSync(path.join(other, 'webview2')), [])
})

test('a Windows pack without the pinned bootstrapper is refused, other targets are not asked', () => {
  const packDir = tmp()
  assert.throws(() => assertPackable('win-x64', packDir), /is missing: a Windows pack ships/)
  assert.throws(() => assertPackable('win-arm64', packDir), /is missing/)
  mkdirSync(path.join(packDir, 'webview2'))
  writeFileSync(path.join(packDir, BOOTSTRAPPER_PATH), Buffer.from('MZ not the pinned file'))
  assert.throws(() => assertPackable('win-x64', packDir), /the pin says/)
  for (const target of ['osx-arm64', 'osx-x64', 'linux-x64']) {
    assert.doesNotThrow(() => assertPackable(target, tmp()))
  }
})

test('--update pins only a Microsoft-signed file, at the address the fwlink led to', () => {
  const dir = tmp()
  const pinFile = path.join(dir, 'pin.json')
  const landed = (url, file) => {
    assert.equal(url, FWLINK)
    writeFileSync(file, BYTES)
    return PIN.url
  }
  const pin = updatePin({ get: landed, verify: () => {}, pinFile })
  assert.deepEqual(pin, PIN)
  assert.deepEqual(readPin(pinFile), PIN)

  const unsigned = () => {
    throw new Error('not signed by Microsoft Corporation')
  }
  const kept = path.join(dir, 'kept.json')
  assert.throws(() => updatePin({ get: landed, verify: unsigned, pinFile: kept }), /not signed/)
  assert.equal(existsSync(kept), false)
  assert.throws(
    () => updatePin({ get: serve(BYTES), verify: () => {}, pinFile: kept }),
    /did not lead to a file address/
  )
})
