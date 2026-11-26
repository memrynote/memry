// Revokes the "Apple Development: Created via API" certificates that Xcode
// cloud signing mints on each ios-testflight.yml run. The runner is
// ephemeral, so it never reuses the one it created, and Apple refuses new
// ones once the team holds its maximum ("Choose a certificate to revoke").
// Certificates under a person's name, Developer ID and distribution
// certificates are left alone.
//
//   node apps/ios/scripts/revoke-ci-dev-certs.mjs [--dry-run]
//
// Reads ASC_KEY_PATH (the .p8 file), ASC_KEY_ID and ASC_ISSUER_ID.
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const API = 'https://api.appstoreconnect.apple.com/v1'
const CI_CERT_NAME = 'Apple Development: Created via API'
const dryRun = process.argv.includes('--dry-run')

function env(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const b64url = (data) => Buffer.from(data).toString('base64url')

function token() {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: env('ASC_KEY_ID'), typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const claims = b64url(
    JSON.stringify({
      iss: env('ASC_ISSUER_ID'),
      iat: now,
      exp: now + 600,
      aud: 'appstoreconnect-v1'
    })
  )
  const key = createPrivateKey(readFileSync(env('ASC_KEY_PATH')))
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363'
  })
  return `${header}.${claims}.${b64url(signature)}`
}

async function call(method, url, jwt) {
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${jwt}` } })
  if (!response.ok) {
    throw new Error(`${method} ${url} answered ${response.status}: ${await response.text()}`)
  }
  return response.status === 204 ? null : response.json()
}

const jwt = token()
let url = `${API}/certificates?filter[certificateType]=DEVELOPMENT&limit=200`
const ids = []
while (url) {
  const page = await call('GET', url, jwt)
  for (const cert of page.data) {
    if (cert.attributes.name === CI_CERT_NAME) ids.push(cert.id)
  }
  url = page.links?.next ?? null
}

console.log(`${ids.length} "${CI_CERT_NAME}" certificate(s)${dryRun ? ' (dry run)' : ''}`)
if (!dryRun) {
  for (const id of ids) {
    await call('DELETE', `${API}/certificates/${id}`, jwt)
    console.log(`revoked ${id}`)
  }
}
