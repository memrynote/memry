import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isMicrosoftSigned, verifyBootstrapper } from './webview2-bootstrapper.mjs'

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

test('the pack refuses a bootstrapper osslsigncode rejects', () => {
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
