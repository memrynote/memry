// macOS dev convenience for the macOS Calendar provider (#2374): adds the
// calendar usage strings to the dev Electron bundle's Info.plist. The EventKit
// helper asks for access as its parent app, and macOS kills a process that asks
// without a usage string, so without this "This Mac" can only report
// "unavailable" under `pnpm dev`. Packaged builds get the strings from
// electron-builder's `mac.extendInfo`. Run: pnpm --filter @memry/desktop dev:calendar-permission
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const require = createRequire(import.meta.url)
const plist = join(
  dirname(require.resolve('electron/package.json')),
  'dist',
  'Electron.app',
  'Contents',
  'Info.plist'
)
if (!existsSync(plist)) process.exit(0)

const text = 'MemryNote (dev) shows the events from your Mac calendars. They stay on this Mac.'
const keys = ['NSCalendarsFullAccessUsageDescription', 'NSCalendarsUsageDescription']

function has(key) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const missing = keys.filter((key) => !has(key))
for (const key of missing) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${text}`, plist])
}
console.log(
  missing.length === 0
    ? 'calendar usage strings already present in dev Electron Info.plist'
    : `patched dev Electron Info.plist with ${missing.join(', ')}`
)
