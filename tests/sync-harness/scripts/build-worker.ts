import * as esbuild from 'esbuild'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

export async function buildWorker(): Promise<string> {
  const outfile = path.resolve(__dirname, '../dist/worker.mjs')
  // Bundle to a process-private file and rename it into place. Playwright can
  // run several E2E workers at once, each booting its own SimulatedServer, and
  // esbuild writes the output in place — two concurrent builds would otherwise
  // let miniflare boot from a half-written worker bundle. rename(2) on the same
  // directory is atomic, so every reader sees a complete file.
  const stagedOutfile = path.resolve(__dirname, `../dist/worker.${process.pid}.mjs`)

  await esbuild.build({
    entryPoints: [path.resolve(ROOT, 'apps/sync-server/src/index.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile: stagedOutfile,
    minify: false,
    sourcemap: false,
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:*'],
    define: {
      'process.env.NODE_ENV': '"test"'
    }
  })

  await fs.rename(stagedOutfile, outfile)

  return outfile
}

if (process.argv[1] && process.argv[1].includes('build-worker')) {
  buildWorker()
    .then((out) => console.log(`Worker bundled: ${out}`))
    .catch((err) => {
      console.error('Build failed:', err)
      process.exit(1)
    })
}
