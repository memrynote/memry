#!/usr/bin/env node
// Drives the Tauri app's renderer over WebDriver with the Playwright-style `page` of pw-compat.
// The VM and staging skills call it where the Electron skills call `cdp.mjs`. Run it from this
// directory under tsx, because pw-compat is TypeScript:
//
//   WD_PORT=9222 node --import tsx scripts/wd.mjs <command> [argument]
//
//   shot <file.png>        screenshot of the window
//   text                   visible text of the page (first 4000 characters)
//   eval '<js>'            evaluate in the renderer, print the value
//   run <script.mjs>       import the script and call its default export with { page, browser }
//
// WD_PORT (default 9222) is the local end of the tunnel to the app's WebDriver. The session is
// kept in `$TMPDIR/memry-wd-<port>.json` and reused, so a command does not open a new one.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { attach } from 'webdriverio'

import { Page } from '../e2e/harness/pw-compat/index.ts'
import { evaluateInPage } from './lib/page-scripts.mjs'
import { createClient } from './lib/webdriver-client.mjs'

const port = Number(process.env.WD_PORT ?? 9222)
const sessionFile = join(tmpdir(), `memry-wd-${port}.json`)

async function openSession(client) {
  try {
    const saved = JSON.parse(readFileSync(sessionFile, 'utf8')).sessionId
    await client.windowHandles(saved)
    return saved
  } catch {
    const sessionId = await client.newSession()
    writeFileSync(sessionFile, JSON.stringify({ sessionId }))
    return sessionId
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2)
  const client = createClient(`http://127.0.0.1:${port}`)
  const sessionId = await openSession(client)
  const browser = await attach({
    sessionId,
    hostname: '127.0.0.1',
    port,
    protocol: 'http',
    logLevel: 'silent',
    path: '/',
    capabilities: { browserName: 'tauri' }
  })
  await browser.setTimeout({ script: 60_000 })
  const page = new Page(browser)
  // Right after launch the document exists but React has not rendered yet.
  if (command === 'text' || command === 'run') {
    await page
      .waitForFunction(() => (document.body?.innerText ?? '').trim().length > 0, null, {
        timeout: 20_000
      })
      .catch(() => console.error('warning: renderer still blank after 20s'))
  }

  if (command === 'shot') {
    if (!argument) throw new Error('usage: shot <file.png>')
    await page.screenshot({ path: argument })
    console.log(argument)
  } else if (command === 'text') {
    console.log((await page.locator('body').innerText()).slice(0, 4000))
  } else if (command === 'eval') {
    if (!argument) throw new Error("usage: eval '<js expression>'")
    const outcome = await evaluateInPage(client, sessionId, argument)
    if (!outcome.ok) throw new Error(String(outcome.error))
    console.log(
      typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value, null, 2)
    )
  } else if (command === 'run') {
    if (!argument) throw new Error('usage: run <script.mjs>')
    const mod = await import(pathToFileURL(resolve(argument)).href)
    await mod.default({ page, browser })
  } else {
    throw new Error(`unknown command: ${command ?? '(none)'}; use shot | text | eval | run`)
  }
}

main().then(
  () => process.exit(0),
  (/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
)
