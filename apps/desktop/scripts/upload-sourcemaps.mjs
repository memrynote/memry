// Hands the renderer's hidden sourcemaps to PostHog so production stack traces
// symbolicate. Runs between `build:release` and `build-packaged-app.js`, because
// `posthog-cli sourcemap inject` writes a `//# chunkId=…` comment into the built
// JS and that comment has to be in the bundle that ships — it is the only thing
// tying a runtime frame back to an uploaded map.
//
// RELEASE SAFETY: with no POSTHOG_CLI_API_KEY / POSTHOG_CLI_PROJECT_ID in the
// environment this is a no-op and the release proceeds byte-for-byte as it does
// today. Nothing here can fail a build that is not configured for it.
//
// The .map files themselves are never packaged — config/electron-builder.yml
// excludes `out/**/*.map`.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(appRoot, 'out', 'renderer', 'assets')

const skip = (reason) => {
  console.log(`[sourcemaps] skipped: ${reason}`)
  process.exit(0)
}

const apiKey = process.env.POSTHOG_CLI_API_KEY
const projectId = process.env.POSTHOG_CLI_PROJECT_ID
if (!apiKey || !projectId) {
  skip('POSTHOG_CLI_API_KEY / POSTHOG_CLI_PROJECT_ID not set')
}

if (!existsSync(assetsDir)) {
  skip(`no renderer assets at ${assetsDir} — run build:release first`)
}

const maps = readdirSync(assetsDir).filter((name) => name.endsWith('.map'))
if (maps.length === 0) {
  skip('renderer build produced no .map files (build.sourcemap disabled?)')
}

const { version } = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'))

const cli = (...args) => {
  execFileSync('npx', ['--yes', '@posthog/cli@latest', ...args], {
    cwd: appRoot,
    stdio: 'inherit',
    shell: false,
    env: process.env
  })
}

console.log(`[sourcemaps] ${maps.length} map(s) in out/renderer/assets for ${version}`)

// Writes the chunk ids into the built JS. Must happen before packaging.
cli('sourcemap', 'inject', '--directory', assetsDir)

cli(
  'sourcemap',
  'upload',
  '--directory',
  assetsDir,
  '--release-name',
  'memry-desktop',
  '--release-version',
  version
)

console.log('[sourcemaps] uploaded')
