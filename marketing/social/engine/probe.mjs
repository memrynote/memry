#!/usr/bin/env node
/**
 * Look at and poke the app a clip is being written against (start it with clip.mjs --open).
 *
 *   node marketing/social/engine/probe.mjs [--slot N] --labels                 # visible controls: role, name, box
 *   node marketing/social/engine/probe.mjs [--slot N] 'await page.keyboard.press("Meta+k")'
 *   node marketing/social/engine/probe.mjs [--slot N] --shot /tmp/x.png [--width 1000] ['<js>']
 *
 * The JS runs as an async function body with `page` (Playwright) in scope; a returned value is
 * printed. Boxes are CSS px in the 1600x900 window, the coordinates scenes.mjs uses.
 */
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const labels = args.includes('--labels') && args.splice(args.indexOf('--labels'), 1)
const slot = Number(flag('slot') ?? process.env.MEMRY_SOCIAL_SLOT ?? 0)
const shot = flag('shot')
const width = flag('width') ?? '1000'
const code = args[0]

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${9222 + 10 * slot}`)
const page = browser
  .contexts()[0]
  .pages()
  .find((p) => p.url().includes('renderer/index.html'))
try {
  if (code) {
    const run = new Function('page', `return (async () => { ${code} })()`)
    const r = await run(page)
    if (r !== undefined) console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1))
  }
  if (labels) {
    const list = await page.evaluate(() => {
      const seen = new Set()
      const rows = []
      const sel =
        'button,a,input,textarea,select,[role=button],[role=tab],[role=menuitem],[role=option],[role=treeitem],[role=link],[role=checkbox],[role=switch],[contenteditable=true],[aria-label]'
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect()
        if (
          r.width < 2 ||
          r.height < 2 ||
          r.bottom < 0 ||
          r.top > innerHeight ||
          r.right < 0 ||
          r.left > innerWidth
        )
          continue
        const st = getComputedStyle(el)
        if (st.visibility === 'hidden' || st.opacity === '0') continue
        const name = (
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.textContent ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 60)
        const role = el.getAttribute('role') || el.tagName.toLowerCase()
        const key = `${role}|${name}|${Math.round(r.x)}|${Math.round(r.y)}`
        if (!name || seen.has(key)) continue
        seen.add(key)
        rows.push(
          `${role.padEnd(9)} ${JSON.stringify(name)} @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
        )
      }
      return rows
    })
    console.log(list.join('\n'))
  }
  if (shot) {
    await page.screenshot({ path: shot, scale: 'css' })
    execFileSync('sips', ['--resampleWidth', width, shot], { stdio: 'ignore' })
    console.log(`shot: ${shot}`)
  }
} catch (err) {
  console.log(`ERR ${err.message.split('\n')[0]}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
