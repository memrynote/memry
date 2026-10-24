// vpk argument lists and Velopack asset names for the five Tauri pack targets.
// Pure functions; `vpk-args.test.mjs` pins every list. The table lives in
// apps/docs/src/contribute/releasing.md ("Update bridge rehearsal").

export const PACK_ID = 'MemryNote'
export const PACK_TITLE = 'MemryNote'
export const PACK_AUTHORS = 'memrynote'

export const TARGETS = {
  'win-x64': {
    os: 'win',
    runtime: 'win-x64',
    channel: 'win',
    mainExe: 'Memrynote.exe',
    framework: 'webview2,vcredist143-x64'
  },
  'win-arm64': {
    os: 'win',
    runtime: 'win-arm64',
    channel: 'win-arm64',
    mainExe: 'Memrynote.exe',
    framework: 'webview2,vcredist143-arm64'
  },
  'osx-arm64': { os: 'osx', runtime: 'osx-arm64', channel: 'osx-arm64', mainExe: 'MemryNote' },
  'osx-x64': { os: 'osx', runtime: 'osx-x64', channel: 'osx-x64', mainExe: 'MemryNote' },
  'linux-x64': { os: 'linux', runtime: 'linux-x64', channel: 'linux', mainExe: 'memrynote' }
}

const DELTA_MODES = new Set(['None', 'BestSpeed', 'BestSize'])

function target(name) {
  const entry = TARGETS[name]
  if (!entry) {
    throw new Error(
      `Unknown pack target "${name}". Expected one of ${Object.keys(TARGETS).join(', ')}`
    )
  }
  return entry
}

function require(value, name) {
  if (!value) {
    throw new Error(`${name} is required`)
  }
}

/**
 * Arguments for `vpk`. The first Tauri pack of a channel passes `delta: 'None'`: a delta against
 * an Electron full package is as large as the full package and the client would prefer it.
 */
export function buildPackArgs(name, options) {
  const t = target(name)
  const { version, packDir, outputDir, delta = 'BestSpeed' } = options
  require(version, 'version')
  require(packDir, 'packDir')
  require(outputDir, 'outputDir')
  if (!DELTA_MODES.has(delta)) {
    throw new Error(`delta must be one of ${[...DELTA_MODES].join(', ')}, got "${delta}"`)
  }

  const args = [
    `[${t.os}]`,
    'pack',
    '--packId',
    PACK_ID,
    '--packTitle',
    PACK_TITLE,
    '--packAuthors',
    PACK_AUTHORS,
    '--packVersion',
    version,
    '--packDir',
    packDir,
    '--mainExe',
    t.mainExe,
    '--runtime',
    t.runtime,
    '--channel',
    t.channel,
    '--outputDir',
    outputDir,
    '--delta',
    delta
  ]

  if (t.os === 'win') {
    require(options.iconPath, 'iconPath')
    args.push('--icon', options.iconPath, '--framework', t.framework, '--noPortable')
    if (options.signTemplate) {
      args.push('--signTemplate', options.signTemplate)
    }
  }

  if (t.os === 'osx') {
    for (const key of ['identity', 'entitlements', 'notaryProfile', 'keychain']) {
      require(options[key], key)
    }
    args.push(
      '--noInst',
      '--signAppIdentity',
      options.identity,
      '--signEntitlements',
      options.entitlements,
      '--signDisableDeep',
      '--notaryProfile',
      options.notaryProfile,
      '--keychain',
      options.keychain
    )
  }

  return args
}

/** Asset names vpk writes for `version`, following Velopack's DefaultName rules (vpk 1.2.161). */
export function assetNames(name, version) {
  const t = target(name)
  require(version, 'version')

  if (name === 'win-x64') {
    return {
      setup: 'MemryNote-win-Setup.exe',
      full: `MemryNote-${version}-full.nupkg`,
      delta: `MemryNote-${version}-delta.nupkg`,
      releases: 'releases.win.json',
      legacyReleases: 'RELEASES'
    }
  }

  if (t.os === 'win') {
    return {
      setup: `MemryNote-${t.channel}-Setup.exe`,
      full: `MemryNote-${version}-${t.channel}-full.nupkg`,
      delta: `MemryNote-${version}-${t.channel}-delta.nupkg`,
      releases: `releases.${t.channel}.json`,
      legacyReleases: `RELEASES-${t.channel}`
    }
  }

  const base = {
    full: `MemryNote-${version}-${t.channel}-full.nupkg`,
    delta: `MemryNote-${version}-${t.channel}-delta.nupkg`,
    releases: `releases.${t.channel}.json`,
    legacyReleases: `RELEASES-${t.channel}`
  }

  if (t.os === 'osx') {
    return {
      ...base,
      portable: `MemryNote-${t.channel}-Portable.zip`,
      squirrelZip: `MemryNote-${version}-${t.runtime.replace('osx-', '')}.zip`
    }
  }

  return {
    ...base,
    portable: 'MemryNote.AppImage',
    appImage: `MemryNote-${version}-x86_64.AppImage`
  }
}
