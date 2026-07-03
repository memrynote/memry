import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

// Regression guard for PR #588 CSP regression: the connect-src directive dropped
// the PostHog ingest host (e.memrynote.com), so browsers blocked every pageview
// and session-replay upload from the landing site for ~16 days. connect-src must
// list every external host the browser talks to.
const REQUIRED_CONNECT_SRC = [
  'https://e.memrynote.com', // PostHog managed reverse proxy — VITE_POSTHOG_HOST
  'https://sync.memrynote.com'
]

function getConnectSrc(): string {
  const vercelPath = fileURLToPath(new URL('../../vercel.json', import.meta.url))
  const config = JSON.parse(readFileSync(vercelPath, 'utf8'))
  const csp = config.headers
    .flatMap((entry: { headers: { key: string; value: string }[] }) => entry.headers)
    .find((header: { key: string }) => header.key === 'Content-Security-Policy')?.value as string
  return csp.split(';').find((directive) => directive.trim().startsWith('connect-src')) ?? ''
}

describe('landing CSP', () => {
  it('allows every host the browser connects to', () => {
    const connectSrc = getConnectSrc()
    for (const host of REQUIRED_CONNECT_SRC) {
      assert.ok(connectSrc.includes(host), `connect-src is missing ${host}`)
    }
  })
})
