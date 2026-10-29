// The page's Content-Security-Policy (inv09 #44).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appReady } from '../../harness/app-ready'
import { test, expect } from '../../harness/test'

const TAURI_CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src-tauri/tauri.conf.json'
)

/** A policy as directive name to sources. Tauri rebuilds the header from a map, so order differs. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name !== '')
      .map(([name, ...sources]) => [name, sources])
  )
}

/** What `served` lacks of `configured`, and what it adds beyond Tauri's own nonces and hashes. */
function policyDrift(served: string, configured: string): string[] {
  const want = directives(configured)
  const got = directives(served)
  const drift: string[] = []
  for (const name of new Set([...want.keys(), ...got.keys()])) {
    const wanted = want.get(name) ?? []
    const sources = got.get(name) ?? []
    for (const source of wanted)
      if (!sources.includes(source)) drift.push(`${name} lacks ${source}`)
    for (const source of sources) {
      // Tauri adds a nonce or a hash to script-src and style-src for each inline script or style.
      const tauriOwn =
        (name === 'script-src' || name === 'style-src') &&
        /^'(nonce|sha256|sha384|sha512)-/.test(source)
      if (!wanted.includes(source) && !tauriOwn) drift.push(`${name} adds ${source}`)
    }
  }
  return drift
}

test('the CSP blocks an injected inline script, and is the configured policy', async ({ page }) => {
  await appReady(page)
  const result = await page.evaluate(async () => {
    const violated: string[] = []
    document.addEventListener('securitypolicyviolation', (event) => {
      violated.push(event.originalPolicy)
    })
    const script = document.createElement('script')
    script.textContent = 'window.__injected = true'
    document.body.append(script)
    for (let tries = 0; violated.length === 0 && tries < 40; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const appPage = await fetch(`${location.protocol}//${location.host}/`)
    return {
      ran: (window as unknown as { __injected?: boolean }).__injected === true,
      enforced: violated[0] ?? null,
      header: appPage.headers.get('content-security-policy')
    }
  })
  expect(result.ran).toBe(false)
  const configured = (
    JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as { app: { security: { csp: string } } }
  ).app.security.csp
  // The policy the page enforces, as the engine reports it, and the header the app page is
  // served with.
  expect(policyDrift(result.enforced ?? '', configured)).toEqual([])
  expect(policyDrift(result.header ?? '', configured)).toEqual([])
})

// The webview has no certificate pin: every memry-host request goes through the Rust transport,
// and `connect-src` names no memrynote.com host, so a request from the renderer is refused
// (`scripts/check-renderer-no-sync-host.mjs` is the source-level backstop).
test('the CSP refuses a webview request to a memry host', async ({ page }) => {
  await appReady(page)
  // The violation report is the evidence: a refused fetch alone proves nothing, since CORS refuses
  // this one whatever the CSP says.
  const violations = await page.evaluate(async () => {
    const blocked: string[] = []
    document.addEventListener('securitypolicyviolation', (event) => {
      blocked.push(`${event.effectiveDirective} ${event.blockedURI}`)
    })
    await fetch('https://sync.memrynote.com/health').catch(() => undefined)
    try {
      new WebSocket('wss://sync.memrynote.com/sync').close()
    } catch {
      // An engine may throw for a blocked socket rather than fail it later; the report is the same.
    }
    for (let tries = 0; blocked.length < 2 && tries < 40; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return blocked
  })
  const reports = violations.join('\n')
  expect(reports).toMatch(/^connect-src https:\/\/sync\.memrynote\.com/m)
  expect(reports).toMatch(/^connect-src wss:\/\/sync\.memrynote\.com/m)
})
