#!/usr/bin/env node
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_NAME = 'com.memry.capture'

function readArg(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)

  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0) return process.argv[index + 1]
  return null
}

function manifestDir(browser, platform = process.platform) {
  const home = homedir()

  if (platform === 'darwin') {
    const root = join(home, 'Library', 'Application Support')
    if (browser === 'dia') return join(root, 'Dia', 'User Data', 'NativeMessagingHosts')
    if (browser === 'edge') return join(root, 'Microsoft Edge', 'NativeMessagingHosts')
    if (browser === 'chromium') return join(root, 'Chromium', 'NativeMessagingHosts')
    return join(root, 'Google', 'Chrome', 'NativeMessagingHosts')
  }

  if (platform === 'win32') {
    throw new Error('Windows native host install needs registry support; install manually for now')
  }

  if (browser === 'chromium') return join(home, '.config', 'chromium', 'NativeMessagingHosts')
  if (browser === 'edge') return join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts')
  return join(home, '.config', 'google-chrome', 'NativeMessagingHosts')
}

function supportDir(platform = process.platform) {
  const home = homedir()
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'memry')
  if (platform === 'win32')
    return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'memry')
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'memry')
}

const extensionId = readArg('extension-id')
if (!extensionId) {
  console.error(
    'Usage: node apps/desktop/scripts/install-chrome-capture-host.mjs --extension-id <id> [--browser chrome|dia|edge|chromium] [--manifest-dir <dir>]'
  )
  process.exit(1)
}

const browser = (readArg('browser') || 'chrome').toLowerCase()
const captureDir = readArg('capture-dir')
const appSupportName = readArg('app-support-name')
const manifestDirOverride = readArg('manifest-dir')
const scriptDir = dirname(fileURLToPath(import.meta.url))
const hostScript = resolve(scriptDir, '../native-host/memry-capture-host.mjs')
const wrapperDir = join(supportDir(), 'native-host')
const wrapperPath = join(wrapperDir, 'memry-capture-host')
const manifestPath = join(
  manifestDirOverride ? resolve(manifestDirOverride) : manifestDir(browser),
  `${HOST_NAME}.json`
)
const envLines = [
  captureDir ? `export MEMRY_CAPTURE_DIR="${captureDir.replaceAll('"', '\\"')}"` : '',
  appSupportName ? `export MEMRY_APP_SUPPORT_NAME="${appSupportName.replaceAll('"', '\\"')}"` : ''
]
  .filter(Boolean)
  .join('\n')

await mkdir(wrapperDir, { recursive: true })
await writeFile(
  wrapperPath,
  `#!/bin/sh\n${envLines ? `${envLines}\n` : ''}exec "${process.execPath}" "${hostScript}"\n`,
  'utf8'
)
await chmod(wrapperPath, 0o755)

await mkdir(dirname(manifestPath), { recursive: true })
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      name: HOST_NAME,
      description: 'Memry local browser capture bridge',
      path: wrapperPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`]
    },
    null,
    2
  ),
  'utf8'
)

console.log(`Installed ${HOST_NAME} for ${browser}: ${manifestPath}`)
