#!/usr/bin/env node
// Drives a running Electron app over CDP: check, download, then quitAndInstall.
// Usage: node scripts/rehearsal/drive-electron-update.mjs <cdp-port> [--timeout-s 600]
// Uses the global WebSocket of Node 24. On NSIS installs the state stays `downloading` until the
// hand-off is armed, so the poll waits for `downloaded` and fails with the last state on timeout.
import { fileURLToPath } from 'node:url'

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

async function connect(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) {
    throw new Error(`No page target on port ${port}`)
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
