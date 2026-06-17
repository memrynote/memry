// ponytail: macOS dev convenience — declares the `memry` URL scheme in the dev
// Electron bundle's Info.plist so `pnpm dev` can receive browser deep-links.
// Packaged builds get this from electron-builder's `protocols:` block instead.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (process.platform !== 'darwin') process.exit(0)

const plist = 'node_modules/electron/dist/Electron.app/Contents/Info.plist'
if (!existsSync(plist)) process.exit(0)

const has = (() => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleURLTypes', plist], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
})()

const cmds = has
  ? []
  : [
      'Add :CFBundleURLTypes array',
      'Add :CFBundleURLTypes:0 dict',
      'Add :CFBundleURLTypes:0:CFBundleURLName string com.memrynote.memry',
      'Add :CFBundleURLTypes:0:CFBundleURLSchemes array',
      'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string memry'
    ]

for (const c of cmds) execFileSync('/usr/libexec/PlistBuddy', ['-c', c, plist])
console.log(
  has
    ? 'memry scheme already present in dev Electron Info.plist'
    : 'patched dev Electron Info.plist with memry scheme'
)
