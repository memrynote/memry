/**
 * Shared by the vector generators of `crates/memry-ml/tests/golden/`: the model folder check, the
 * `--check` comparison and the write-or-check entry point.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
export const VECTORS = join(ROOT, 'packages/contracts/test-vectors')

export const MODEL_REPO = 'onnx-community/embeddinggemma-2-ONNX'
export const MODEL_REVISION = 'daa72c51243991dfcaf9f9137d2c573d8f7790c0'

/** `EMBEDDING_DIMENSION` of the worker. */
export const DIMENSION = 256

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const sha256File = (path) => sha256(readFileSync(path))

export const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)

/**
 * `--model-dir <dir>` or `MEMRY_ML_MODEL_DIR`: a `.../onnx-community/embeddinggemma-2-ONNX` folder
 * whose `pins` (path to sha256) match. Nothing is downloaded.
 */
export function modelDir(pins) {
  const flag = process.argv.indexOf('--model-dir')
  const dir = flag === -1 ? process.env.MEMRY_ML_MODEL_DIR : process.argv[flag + 1]
  if (!dir) throw new Error('pass --model-dir <.../onnx-community/embeddinggemma-2-ONNX>')
  const abs = resolve(dir)
  if (!abs.split(/[\\/]/).join('/').endsWith(MODEL_REPO)) {
    throw new Error(`${abs} is not a ${MODEL_REPO} folder`)
  }
  for (const [file, pin] of Object.entries(pins)) {
    if (sha256File(join(abs, file)) !== pin) throw new Error(`${file} is not the pinned file`)
  }
  return abs
}

/** embedding-worker.ts `truncateEmbedding`. */
export function truncateEmbedding(full) {
  const out = new Float32Array(DIMENSION)
  let norm = 0
  for (let i = 0; i < DIMENSION; i++) {
    out[i] = full[i]
    norm += full[i] * full[i]
  }
  norm = Math.sqrt(norm)
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding is not finite')
  for (let i = 0; i < DIMENSION; i++) out[i] /= norm
  return out
}

/** A stored vector: nine significant digits give back the same f32. */
export const storedVector = (vector) => Array.from(vector, (value) => Number(value.toPrecision(9)))

/**
 * Differences between two renders: exact on everything but `embedding`, which may differ within
 * `tolerance` (`minCosine`, `maxComponentDiff`), so a run on another CPU or thread count still
 * passes.
 */
export function differences(committed, fresh, tolerance, path = '') {
  if (path.endsWith('.embedding') && Array.isArray(committed) && Array.isArray(fresh)) {
    const worst = Math.max(...committed.map((value, i) => Math.abs(value - fresh[i])))
    return committed.length === fresh.length &&
      dot(committed, fresh) >= tolerance.minCosine &&
      worst <= tolerance.maxComponentDiff
      ? []
      : [`${path}: cosine ${dot(committed, fresh)}, largest component difference ${worst}`]
  }
  if (
    typeof committed !== 'object' ||
    committed === null ||
    typeof fresh !== 'object' ||
    fresh === null
  ) {
    return Object.is(committed, fresh) ? [] : [`${path}: ${committed} != ${fresh}`]
  }
  const keys = new Set([...Object.keys(committed), ...Object.keys(fresh)])
  return [...keys].flatMap((key) =>
    differences(committed[key], fresh[key], tolerance, `${path}.${key}`)
  )
}

/** Writes `fresh` to `out`, or with `--check` compares it with the committed file and exits 1. */
export function writeOrCheck(out, fresh, tolerance) {
  if (!process.argv.includes('--check')) {
    writeFileSync(out, fresh, 'utf8')
    process.stdout.write(`wrote ${out}\n`)
    return
  }
  let found = [`${basename(out)} is missing`]
  try {
    found = differences(JSON.parse(readFileSync(out, 'utf8')), JSON.parse(fresh), tolerance)
  } catch (error) {
    found = [`${basename(out)}: ${error instanceof Error ? error.message : String(error)}`]
  }
  if (found.length > 0) {
    process.stderr.write(
      `${basename(out)} regenerates differently:\n${found.slice(0, 20).join('\n')}\n`
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(`${basename(out)} is current\n`)
}
