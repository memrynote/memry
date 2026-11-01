#!/usr/bin/env node
// Drives a running Electron app over CDP: check, download, then quitAndInstall.
// Usage: node scripts/rehearsal/drive-electron-update.mjs <cdp-port> [--timeout-s 600]
// Uses the global WebSocket of Node 24. On NSIS installs the state stays `downloading` until the
// hand-off is armed, so the poll waits for `downloaded` and fails with the last state on timeout.
import { isMain } from '../release/is-main.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function describeState(state) {
  return state && typeof state === 'object' ? JSON.stringify(state) : String(state)
}

export async function pollUntil(read, isDone, { timeoutMs, intervalMs = 2000 }) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (isDone(last)) {
      return last
    }
    await sleep(intervalMs)
  }
  throw new Error(`Timed out. Last state: ${describeState(last)}`)
}

/**
 * The main window's page. The app opens more pages later, such as the PDF host once a vault with
 * PDFs is indexed, and those have no `window.api`. Quick Capture and the sticky windows load the
 * same `index.html` with their own hash (`#quick-capture`, `#sticky`, `#sticky-tab`), while the
 * main window loads it bare, so a URL with a hash or a query is never the main window.
 */
export function mainPage(targets) {
  return targets.find(
    (target) => target.type === 'page' && target.url.endsWith('/renderer/index.html')
  )
}

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = mainPage(targets)
  if (!page) {
    throw new Error(`No main window page target on port ${port}`)
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })

  return {
    close: () => socket.close(),
    async evaluate(expression) {
      const id = nextId++
      const reply = new Promise((resolve) => pending.set(id, resolve))
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
      const { result, error } = await reply
      if (error || result.exceptionDetails) {
        throw new Error(describeState(error ?? result.exceptionDetails))
      }
      return result.result.value
    }
  }
}

async function main(argv) {
  const port = Number(argv[0])
  const timeoutIndex = argv.indexOf('--timeout-s')
  const timeoutMs = (timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : 600) * 1000
  if (!Number.isInteger(port)) {
    console.error('usage: drive-electron-update.mjs <cdp-port> [--timeout-s N]')
    process.exit(2)
  }

  const cdp = await connect(port)
  try {
    console.log('check:', describeState(await cdp.evaluate('window.api.updater.checkForUpdates()')))
    console.log(
      'download:',
      describeState(await cdp.evaluate('window.api.updater.downloadUpdate()'))
    )
    const state = await pollUntil(
      () => cdp.evaluate('window.api.updater.getState()'),
      (current) => current?.status === 'downloaded',
      { timeoutMs }
    )
    console.log('downloaded:', describeState(state))
    // quitAndInstall tears the app down, so the reply may never arrive.
    await Promise.race([cdp.evaluate('window.api.updater.quitAndInstall()'), sleep(5000)])
    console.log('quitAndInstall sent')
  } finally {
    cdp.close()
  }
}

if (isMain(import.meta)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
