import * as esbuild from 'esbuild'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

export async function buildWorker(): Promise<string> {
  const outfile = path.resolve(__dirname, '../dist/worker.mjs')

  await esbuild.build({
    entryPoints: [path.resolve(ROOT, 'apps/sync-server/src/index.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile,
    minify: false,
    sourcemap: false,
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:*'],
    define: {
      'process.env.NODE_ENV': '"test"'
    }
  })

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
