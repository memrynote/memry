// The Tauri config a release build reads: `tauri.conf.json`, then the platform file
// `tauri.<platform>.conf.json`, then the release overlay `tauri.release.conf.json` that
// `tauri build --config` adds, each merged as a JSON merge patch (RFC 7396), as the Tauri CLI does.
// A merge patch replaces an array whole, so the macOS overlay `tauri.release.macos.conf.json`
// restates `externalBin` with the EventKit helper that `tauri.macos.conf.json` adds, and the build
// passes it after the release overlay. The overlay holds `bundle.resources` and `externalBin` because tauri-build copies both on every
// build of memry-tauri, clippy and tests included, and fails on a missing path.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const TAURI_DIR = path.resolve(import.meta.dirname, '../../apps/desktop-tauri/src-tauri')
export const PLATFORMS = ['windows', 'macos', 'linux']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function mergePatch(target, patch) {
  if (!isObject(patch)) return patch
  const merged = isObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else merged[key] = mergePatch(merged[key], value)
  }
  return merged
}

export function readReleaseConfig(platform, tauriDir = TAURI_DIR) {
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`unknown platform ${platform}; known: ${PLATFORMS.join(', ')}`)
  }
  const read = (name) => JSON.parse(readFileSync(path.join(tauriDir, name), 'utf8'))
  const platformFile = `tauri.${platform}.conf.json`
  let config = read('tauri.conf.json')
  if (existsSync(path.join(tauriDir, platformFile))) config = mergePatch(config, read(platformFile))
  config = mergePatch(config, read('tauri.release.conf.json'))
  const releasePlatformFile = `tauri.release.${platform}.conf.json`
  if (existsSync(path.join(tauriDir, releasePlatformFile))) {
    config = mergePatch(config, read(releasePlatformFile))
  }
  return config
}
