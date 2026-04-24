// S3 bundle-size measurement (Test #8) — builds each prototype in release mode
// and measures the resulting .app bundle size with `du -sh`.
//
// Output: `s3-bundle-size.json` (separate from query latency to keep concerns
// distinct; `s3-db-placement.md` consolidates).

import { execSync } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { collectEnvironment } from './collect-environment.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../../..')
const BENCH_OUT = resolve(__dirname, '../benchmarks/s3-bundle-size.json')

interface OptionBundle {
  option: 'A' | 'B' | 'C'
  prototypeDir: string
  productName: string
}

const OPTIONS: OptionBundle[] = [
  {
    option: 'A',
    prototypeDir: resolve(REPO_ROOT, 'spikes/tauri-risk-discovery/prototypes/s3-rusqlite'),
    productName: 's3-rusqlite',
  },
  {
    option: 'B',
    prototypeDir: resolve(REPO_ROOT, 'spikes/tauri-risk-discovery/prototypes/s3-plugin-sql'),
    productName: 's3-plugin-sql',
  },
  {
    option: 'C',
    prototypeDir: resolve(REPO_ROOT, 'spikes/tauri-risk-discovery/prototypes/s3-hybrid'),
    productName: 's3-hybrid',
  },
]

interface BundleResult {
  option: 'A' | 'B' | 'C'
  appBundlePath: string | null
  appBundleBytes: number | null
  binarySizeBytes: number | null
  notes: string
}

function findAppBundle(prototypeDir: string, productName: string): string | null {
  const candidates = [
    `src-tauri/target/release/bundle/macos/${productName}.app`,
    `src-tauri/target/release/bundle/macos/${productName}_0.1.0_aarch64.app`,
    `src-tauri/target/release/bundle/macos/${productName}_0.1.0_x86_64.app`,
  ]
  for (const c of candidates) {
    const full = resolve(prototypeDir, c)
    if (existsSync(full)) return full
  }
  return null
}

function findReleaseBinary(prototypeDir: string, productName: string): string | null {
  const candidates = [
    `src-tauri/target/release/${productName}`,
    `src-tauri/target/release/app`,
  ]
  for (const c of candidates) {
    const full = resolve(prototypeDir, c)
    if (existsSync(full)) return full
  }
  return null
}

function bytesViaDu(path: string): number {
  // `du -sk` returns kilobytes (1024-byte blocks on macOS by default).
  const out = execSync(`du -sk "${path}"`, { encoding: 'utf8' }).trim()
  const kb = parseInt(out.split(/\s+/)[0] ?? '0', 10)
  return kb * 1024
}

async function buildAndMeasure(cfg: OptionBundle): Promise<BundleResult> {
  console.log(`[bundle] building ${cfg.option} (${cfg.prototypeDir})`)
  const notes: string[] = []
  try {
    execSync('pnpm tauri build', {
      cwd: cfg.prototypeDir,
      stdio: 'inherit',
    })
  } catch (err) {
    notes.push(`build failed: ${String(err).slice(0, 200)}`)
    return {
      option: cfg.option,
      appBundlePath: null,
      appBundleBytes: null,
      binarySizeBytes: null,
      notes: notes.join('; '),
    }
  }

  const appBundle = findAppBundle(cfg.prototypeDir, cfg.productName)
  const binary = findReleaseBinary(cfg.prototypeDir, cfg.productName)

  return {
    option: cfg.option,
    appBundlePath: appBundle,
    appBundleBytes: appBundle ? bytesViaDu(appBundle) : null,
    binarySizeBytes: binary && existsSync(binary) ? statSync(binary).size : null,
    notes: notes.join('; ') || 'ok',
  }
}

async function main(): Promise<void> {
  const env = await collectEnvironment()
  const results: BundleResult[] = []

  for (const cfg of OPTIONS) {
    results.push(await buildAndMeasure(cfg))
  }

  const output = {
    schema_version: 1,
    spike: 's3-db-placement',
    benchmark: 'bundle-size',
    timestamp: new Date().toISOString(),
    environment: env,
    results,
    notes:
      'Release builds via `pnpm tauri build`. macOS .app bundle measured via `du -sk`; binary size via stat. ' +
      'Linux/Windows deferred to Subproject 7.',
  }

  writeFileSync(BENCH_OUT, JSON.stringify(output, null, 2))
  console.log(`[bundle] wrote ${BENCH_OUT}`)
}

main().catch((err) => {
  console.error('[bundle] fatal:', err)
  process.exit(1)
})
