// The vault from the shell: ls, cat, ls journal and grep, replayed with their real output on
// today's base vault (the folder is shown as ~/Documents/Maya, where a user would keep it).
import { execFileSync } from 'node:child_process'

const sh = (cmd, args, columns = 76) =>
  execFileSync(cmd, args, {
    cwd: process.env.MEMRY_SOCIAL_VAULT,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', COLUMNS: String(columns) }
  })
const run = (page, command, output, opts = {}) =>
  page.evaluate(([c, o, x]) => term.run(c, o, x), [command, output, opts])
const box = (page, n) => page.evaluate((k) => term.box(k), n)
// x = 0 pins the zoom to the left edge (the compositor clamps the camera to the frame).
const zoomLines = async ({ page, zoom }, n, z) => {
  const b = await box(page, n)
  zoom(0, b.y + b.height / 2, z)
}

export async function setup({ page }) {
  await page.addStyleTag({ content: '#__tut_cursor { display: none }' })
  await page.evaluate(() => term.setTitle('maya — zsh'))
  await run(page, 'cd Documents/Maya', '', { cps: 2000, after: '~/Documents/Maya' })
  await run(page, 'ls', sh('ls', ['-C']), { cps: 2000 })
}

export const scenes = {
  async hook({ page, at }) {
    await at(1.0)
    await run(page, 'cat "Meetings/Weekly sync with Sam.md"', '', { cps: 17 }).catch(() => {})
  },
  async cat(ctx) {
    const out = sh('cat', ['Meetings/Weekly sync with Sam.md'])
    await ctx.page.evaluate((o) => {
      // The hook typed the command; print its output under it.
      const lines = document.getElementById('lines')
      for (const line of o.replace(/\n$/, '').split('\n')) {
        const el = document.createElement('div')
        el.textContent = line || ' '
        lines.append(el)
      }
    }, out)
    await zoomLines(ctx, out.trim().split('\n').length + 1, 1.45)
  },
  async journal(ctx) {
    ctx.unzoom()
    await ctx.sleep(350)
    const out = sh('ls', ['-C', 'journal'], 54)
    await run(ctx.page, 'ls journal', out, { cps: 10 })
    await zoomLines(ctx, out.trim().split('\n').length + 1, 1.5)
  },
  async grep(ctx) {
    ctx.unzoom()
    await ctx.sleep(350)
    // A fresh screen, so the matches print up top, clear of the caption, and wrap where the zoom
    // can show whole lines.
    await run(ctx.page, 'clear', '', { cps: 9 })
    await ctx.page.evaluate(() => {
      term.clear()
      document.getElementById('screen').style.paddingRight = '430px'
    })
    const out = sh('grep', ['-ri', 'lisbon', 'journal'])
    await run(ctx.page, 'grep -ri lisbon journal', out, { cps: 12, hit: 'lisbon' })
    const b = await box(ctx.page, 8)
    ctx.zoom(0, b.y + b.height / 2, 1.32)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
