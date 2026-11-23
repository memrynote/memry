/**
 * Whether this process's `stat` reports a file's real birthtime. Where Linux
 * has no statx (kernel before 4.11, or a seccomp filter that blocks it), libuv
 * falls back to stat(2) for the whole process and reports the ctime as the
 * birthtime. The probe moves a temp file's ctime and watches whether the
 * birthtime follows it, once per process.
 *
 * @module vault/birthtime-probe
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { createLogger } from '../lib/logger'

const logger = createLogger('Watcher')

/** Long enough for a 1 s ctime granularity to tick over. */
const PROBE_LIMIT_MS = 2000
const PROBE_STEP_MS = 10

let realBirthtime: boolean | null = null
let probe: Promise<boolean | null> | null = null

/** The probe's answer: null until it ran, or when it could not tell. */
export function birthtimeIsReal(): boolean | null {
  return realBirthtime
}

/** Runs the probe once per process; later calls return the same answer. */
export function probeBirthtime(): Promise<boolean | null> {
  probe ??= runProbe().then(
    (answer) => {
      realBirthtime = answer
      logger.info(
        `Birthtime probe: ${answer === null ? 'inconclusive' : answer ? 'real' : 'ctime'}`
      )
      return answer
    },
    (error: unknown) => {
      logger.warn(
        `Birthtime probe failed; a birthtime equal to the ctime counts as none: ${String(error)}`
      )
      return null
    }
  )
  return probe
}

async function runProbe(): Promise<boolean | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-birthtime-'))
  try {
    const file = path.join(dir, 'probe')
    await fs.writeFile(file, '')
    const born = await fs.stat(file)
    for (let waited = 0; waited < PROBE_LIMIT_MS; waited += PROBE_STEP_MS) {
      await new Promise((resolve) => setTimeout(resolve, PROBE_STEP_MS))
      await fs.chmod(file, waited % (2 * PROBE_STEP_MS) === 0 ? 0o600 : 0o644)
      const later = await fs.stat(file)
      if (later.ctimeMs !== born.ctimeMs) return later.birthtimeMs !== later.ctimeMs
    }
    return null
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
