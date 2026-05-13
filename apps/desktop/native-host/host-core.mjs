import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { spawn } from 'node:child_process'

const HOST_NAME = 'com.memry.capture'
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024

function readUInt32LE(buffer) {
  if (buffer.length < 4) throw new Error('Native message is missing its length header')
  return buffer.readUInt32LE(0)
}

function appSupportDir({
  env = process.env,
  platform = process.platform,
  homeDir = homedir()
} = {}) {
  const appName =
    env.MEMRY_APP_SUPPORT_NAME || (env.MEMRY_DEVICE ? `memry-${env.MEMRY_DEVICE}` : 'memry')

  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', appName)
  if (platform === 'win32') return join(env.APPDATA || join(homeDir, 'AppData', 'Roaming'), appName)
  return join(env.XDG_CONFIG_HOME || join(homeDir, '.config'), appName)
}

export function getPendingCaptureDir(options = {}) {
  const env = options.env || process.env
  if (env.MEMRY_CAPTURE_DIR) return env.MEMRY_CAPTURE_DIR

  return join(appSupportDir(options), 'capture-inbox', 'pending')
}

function validateCaptureMessage(message) {
  if (!message || typeof message !== 'object') throw new Error('Capture message must be an object')
  if (message.schemaVersion !== 1) throw new Error('Unsupported capture schema version')
  if (message.source !== 'chrome-extension') throw new Error('Unsupported capture source')
  if (!message.capture || typeof message.capture !== 'object') {
    throw new Error('Capture payload is required')
  }

  const kind = message.capture.kind
  if (!['link', 'clip', 'page', 'file'].includes(kind)) {
    throw new Error(`Unsupported capture kind: ${kind}`)
  }

  if (kind === 'file') {
    if (typeof message.capture.dataBase64 !== 'string' || message.capture.dataBase64.length === 0) {
      throw new Error('File capture requires base64 data')
    }

    const byteLength = Math.floor((message.capture.dataBase64.length * 3) / 4)
    if (byteLength > MAX_CAPTURE_BYTES) {
      throw new Error('Capture exceeds the 50 MB local attachment limit')
    }
  }
}

export async function writePendingCapture(message, options = {}) {
  validateCaptureMessage(message)

  const captureDir = options.captureDir || getPendingCaptureDir(options)
  await mkdir(captureDir, { recursive: true })

  const id = `capture-${Date.now()}-${randomUUID()}`
  const path = join(captureDir, `${id}.json`)
  const tempPath = `${path}.tmp`
  const payload = {
    ...message,
    id,
    receivedAt: new Date().toISOString(),
    nativeHost: HOST_NAME
  }

  await writeFile(tempPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
  await rename(tempPath, path)
  return { ok: true, id, path }
}

function spawnDetached(command, args, spawnImpl = spawn) {
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref?.()
}

function getSafeMacAppPath(env) {
  const appPath = env.MEMRY_APP_PATH
  if (typeof appPath !== 'string') return undefined
  if (!isAbsolute(appPath) || appPath.includes('\0')) return undefined
  return appPath.endsWith('.app') ? appPath : undefined
}

export function launchMemry({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn
} = {}) {
  if (platform === 'darwin') {
    const appPath = getSafeMacAppPath(env)
    if (appPath) {
      spawnDetached('open', [appPath], spawnImpl)
    } else {
      spawnDetached('open', ['-a', 'Memry'], spawnImpl)
    }
    return
  }

  if (platform === 'win32') {
    spawnDetached('Memry.exe', [], spawnImpl)
    return
  }

  spawnDetached('gtk-launch', ['memry'], spawnImpl)
}

export async function readNativeMessage(input = process.stdin) {
  if (Buffer.isBuffer(input)) return parseNativeMessage(input)

  let buffer = Buffer.alloc(0)
  for await (const chunk of input) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)])
    if (buffer.length < 4) continue

    const length = readUInt32LE(buffer)
    if (buffer.length >= 4 + length) return parseNativeMessage(buffer.subarray(0, 4 + length))
  }

  return parseNativeMessage(buffer)
}

function parseNativeMessage(buffer) {
  const length = readUInt32LE(buffer)
  const payload = buffer.subarray(4, 4 + length)
  if (payload.length !== length) throw new Error('Native message ended before the declared length')
  return JSON.parse(payload.toString('utf8'))
}

export function writeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

export async function handleNativeMessage(message, options = {}) {
  const result = await writePendingCapture(message, options)
  try {
    launchMemry(options)
  } catch (error) {
    return {
      ok: true,
      captureId: result.id,
      launchRequested: false,
      launchError: error instanceof Error ? error.message : String(error)
    }
  }

  return { ok: true, captureId: result.id, launchRequested: true }
}
