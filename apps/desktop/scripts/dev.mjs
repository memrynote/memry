// Starts `electron-vite dev` with the given flags. When the last dev build of main and
// preload is still current (see dev-build-reuse.mts), it adds --rendererOnly so electron-vite
// reuses that build. MEMRY_DEV_REBUILD=1 builds them anyway.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lastDevBuildIsCurrent } from './dev-build-reuse.mts'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const args = ['dev', ...process.argv.slice(2)]
// Watch mode rebuilds main and preload on change, so it starts from a build of its own.
const watch = args.includes('-w') || args.includes('--watch')
if (process.env.MEMRY_DEV_REBUILD !== '1' && !watch && lastDevBuildIsCurrent(appRoot, args)) {
  console.log(
    'main and preload are unchanged since the last dev build; MEMRY_DEV_REBUILD=1 rebuilds them'
  )
  args.push('--rendererOnly')
}

const require = createRequire(import.meta.url)
const packageJson = require.resolve('electron-vite/package.json')
const cli = join(dirname(packageJson), require(packageJson).bin['electron-vite'])
const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' })

// Ctrl+C reaches electron-vite and Electron through the terminal's process group, so this
// process only waits for them. A signal sent to this process alone is passed on.
process.on('SIGINT', () => {})
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
