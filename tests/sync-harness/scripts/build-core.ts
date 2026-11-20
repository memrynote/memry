import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

// Builds the core device the harness drives (`crates/memry-cli`, #5232). A
// machine without cargo still runs the TypeScript scenarios: the build warns
// and the core scenario skips. CI must run it, so there a missing cargo fails.

const CRATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../crates')

if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).error) {
  const message =
    'cargo is not on PATH: the core device (memry-cli) is not built. Install the Rust toolchain (rustup, pinned by crates/rust-toolchain.toml) to run the core zero-loss scenario.'
  if (process.env.CI) {
    console.error(message)
    process.exit(1)
  }
  console.warn(`WARNING: ${message} The scenario skips.`)
  process.exit(0)
}

const build = spawnSync('cargo', ['build', '-p', 'memry-cli'], { cwd: CRATES, stdio: 'inherit' })
process.exit(build.status ?? 1)
