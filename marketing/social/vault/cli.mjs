// The memrynote CLI of the checkout being filmed, pointed at one vault, so seeded data is what
// that build itself writes. It runs under the checkout's Electron because the native modules are
// built for Electron. Flags: apps/cli/src/run.ts.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

export function cliFor(app, vault) {
  const electron = createRequire(path.join(app, 'apps/desktop/package.json'))('electron')
  const entry = path.join(app, 'apps/cli/src/index.ts')
  return (...args) => {
    const r = spawnSync(
      electron,
      [
        '--no-warnings',
        '--experimental-strip-types',
        '--experimental-transform-types',
        entry,
        '--vault',
        vault,
        '--json',
        ...args
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', maxBuffer: 64 << 20 }
    )
    if (r.status !== 0) throw new Error(`memrynote ${args.join(' ')}\n${r.stderr || r.stdout}`)
    return r.stdout.trim() ? JSON.parse(r.stdout) : null
  }
}

const pad = (n) => String(n).padStart(2, '0')
/** YYYY-MM-DD, `offset` days from today (local time). */
export function day(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** Local ISO time with offset, `offset` days from today at `hhmm` ("09:30"). */
export function at(offset, hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date()
  d.setDate(d.getDate() + offset)
  d.setHours(h, m, 0, 0)
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  return `${day(offset)}T${pad(h)}:${pad(m)}:00${sign}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`
}
export const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Write a file into the vault (relative path), creating folders. */
export function writer(vault) {
  return (rel, content) => {
    const f = path.join(vault, rel)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, content)
    return f
  }
}
