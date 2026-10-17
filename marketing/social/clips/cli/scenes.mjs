// The memrynote CLI, replayed with real output: the commands run against a scratch copy of
// today's base vault through the filmed build's CLI, and the terminal shows them as an installed
// `memrynote` (Settings → Command Line) would.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { day } from '../../vault/cli.mjs'

const SCRATCH = '/tmp/memry-social/cli-clip/Maya'
let fn
function shell(cmdline) {
  return execFileSync('/bin/zsh', ['-c', `${fn}\n${cmdline}`], {
    encoding: 'utf8',
    cwd: SCRATCH,
    env: { ...process.env, LC_ALL: 'C' }
  })
}
const run = (page, command, output, opts = {}) =>
  page.evaluate(([c, o, x]) => term.run(c, o, x), [command, output, opts])
const box = (page, n) => page.evaluate((k) => term.box(k), n)
const zoomLines = async ({ page, zoom }, n, z) => {
  const b = await box(page, n)
  zoom(0, b.y + b.height / 2, z)
}
let pending

export async function setup({ page }) {
  const app = process.env.MEMRY_SOCIAL_APP
  const electron = createRequire(path.join(app, 'apps/desktop/package.json'))('electron')
  const entry = path.join(app, 'apps/cli/src/index.ts')
  fs.rmSync(path.dirname(SCRATCH), { recursive: true, force: true })
  fs.cpSync(process.env.MEMRY_SOCIAL_VAULT, SCRATCH, { recursive: true })
  fn = `memrynote() { ELECTRON_RUN_AS_NODE=1 "${electron}" --no-warnings --experimental-strip-types --experimental-transform-types "${entry}" --vault "${SCRATCH}" "$@" }`
  await page.addStyleTag({ content: '#__tut_cursor { display: none }' })
  await page.evaluate(() => term.setTitle('maya — zsh'))
  await page.evaluate(() => (document.getElementById('screen').style.paddingRight = '300px'))
  const help = shell('memrynote --help 2>&1 || true')
  await run(page, 'memrynote --help', help, { cps: 2000 })
}

export const scenes = {
  async hook({ page, at }) {
    await at(0.9)
    const cmd = `memrynote notes create "Lisbon restaurants" --folder Lisbon | jq '{title, path}'`
    pending = shell(cmd)
    await run(page, cmd, '', { cps: 26 })
  },
  async note(ctx) {
    await ctx.page.evaluate((o) => {
      const lines = document.getElementById('lines')
      for (const line of o.replace(/\n$/, '').split('\n')) {
        const el = document.createElement('div')
        el.textContent = line || ' '
        lines.append(el)
      }
    }, pending)
    await zoomLines(ctx, pending.trim().split('\n').length + 2, 1.4)
  },
  async task(ctx) {
    ctx.unzoom()
    await ctx.sleep(300)
    const cmd = `memrynote tasks create "Book a table at Taberna" --due ${day(3)} | jq '{title, dueDate}'`
    const out = shell(cmd)
    await run(ctx.page, cmd, out, { cps: 32 })
    await zoomLines(ctx, out.trim().split('\n').length + 2, 1.4)
    await ctx.sleep(2200)
  },
  async list(ctx) {
    ctx.unzoom()
    await ctx.sleep(300)
    await run(ctx.page, 'clear', '', { cps: 9 })
    await ctx.page.evaluate(() => term.clear())
    const cmd = `memrynote tasks list --due-before ${day(4)} | jq -r '.[] | select(.dueDate) | .dueDate + "  " + .title' | sort | head -8`
    const out = shell(cmd)
    await run(ctx.page, cmd, out, { cps: 36 })
    await zoomLines(ctx, out.trim().split('\n').length + 3, 1.35)
    await ctx.sleep(3000)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
