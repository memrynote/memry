// BBF-114 regression on main
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const WT = process.env.WT
const outDir = process.env.OUT
fs.mkdirSync(outDir, { recursive: true })
const require = createRequire(path.join(WT, 'apps/desktop/package.json'))
const { chromium } = require('@playwright/test')
const state = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8'))
const log = (line) => {
  console.log(line)
  fs.appendFileSync(path.join(outDir, 'transcript.txt'), `${line}\n`)
}
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' ' + detail : ''}`)
}
log(`vault ${state.vaultPath}`)
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => !p.url().startsWith('devtools://'))
const ready = () =>
  page.waitForFunction(async () => (await window.api.vault.getStatus())?.isOpen, undefined, {
    timeout: 45_000,
    polling: 250
  })
await ready()
const dismiss = async () => {
  for (const name of ['Skip', 'Skip tour', 'Close', 'Got it'])
    await page
      .getByRole('button', { name, exact: true })
      .click({ timeout: 500 })
      .catch(() => {})
}
await dismiss()
async function byPath(rel) {
  for (let i = 0; i < 80; i++) {
    const found = await page.evaluate((p) => window.api.notes.getByPath(p), rel).catch(() => null)
    const note = found?.note ?? found
    if (note?.id) return note
    await page.waitForTimeout(500)
  }
  throw new Error(`not indexed: ${rel}`)
}
const tabFor = (title) =>
  page.locator('[role="tab"][data-group-id]').filter({ hasText: title }).first()
async function openNote(note, title) {
  const detail = { id: note.id, title, emoji: null }
  const tab = tabFor(title)
  for (let i = 0; i < 20; i++) {
    await page.evaluate(
      (d) => window.dispatchEvent(new CustomEvent('memry:test-open-note', { detail: d })),
      detail
    )
    if (await tab.isVisible().catch(() => false)) break
    await page.waitForTimeout(500)
  }
  await tab.click()
  const editor = page.locator('[aria-label="Rich text editor"] [contenteditable="true"]').first()
  await editor.waitFor({ state: 'visible', timeout: 15_000 })
  return editor
}
async function typeAtEnd(editor, selector, ch) {
  const block = editor
    .locator(selector)
    .last()
    .locator('xpath=ancestor::*[contains(@class,"bn-block-outer")][1]')
  await block.click({ position: { x: 5, y: 5 } })
  await block.evaluate((el) => {
    const root = el.querySelector('code') ?? el
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let last = null
    while (walker.nextNode()) if (walker.currentNode.textContent.trim()) last = walker.currentNode
    const range = document.createRange()
    range.setStart(last, last.textContent.length)
    range.collapse(true)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await page.waitForTimeout(300)
  await page.keyboard.type(ch)
  await page.waitForTimeout(6000)
}
const Q = '[data-content-type="codeBlock"]'
const CASES = [
  { name: 'FzA', body: '> a\n>\n> ```\n> b\n> ```\n\n```\nc\n```' },
  { name: 'FzB', body: '> - a\n>\n> ```\n> b\n> ```\n\n```\nc\n```' },
  { name: 'FzC', body: '```\nc\n```' },
  { name: 'FzD', body: '> a\n>\n> ```\n> b\n> ```\n\n```py\nc\n```' },
  { name: 'FzE', body: '    c' }
]
const edit = async (c, name, abs, ch) => {
  const note = await byPath(`${name}.md`)
  await page.waitForTimeout(1500)
  const editor = await openNote(note, name)
  await page.waitForTimeout(3000)
  return editor
}
const results = {}
const body = (c) => `# ${c.name}\n\n${c.body}\n\nend c\n`
for (const c of CASES) {
  const text = body(c)
  c.abs = path.join(state.vaultPath, `${c.name}.md`)
  fs.writeFileSync(c.abs, text)
  c.note = await byPath(`${c.name}.md`)
  await page.waitForTimeout(1500)
  const editor = await openNote(c.note, c.name)
  await page.waitForTimeout(3000)
  check(`${c.name} not rewritten on open`, fs.readFileSync(c.abs, 'utf8') === text)
  await page.screenshot({ path: path.join(outDir, `${c.name}-0-open.png`) })
  await typeAtEnd(editor, Q, '!').catch((e) => {
    log(`${c.name} typeAtEnd error ${e.message.split('\n')[0]}`)
  })
  await page.screenshot({ path: path.join(outDir, `${c.name}-1-first-edit.png`) })
  results[c.name] = { orig: text, first: fs.readFileSync(c.abs, 'utf8') }
  log(`${c.name} first write-back ${JSON.stringify(results[c.name].first)}`)
}
await page.reload()
await ready()
await dismiss()
for (const c of CASES) {
  const editor = await openNote(c.note, c.name)
  await page.waitForTimeout(3000)
  check(
    `${c.name} unchanged after reopen`,
    fs.readFileSync(c.abs, 'utf8') === results[c.name].first
  )
  await typeAtEnd(editor, Q, '?').catch((e) => {
    log(`${c.name} typeAtEnd2 error ${e.message.split('\n')[0]}`)
  })
  await page.screenshot({ path: path.join(outDir, `${c.name}-2-second-edit.png`) })
  results[c.name].second = fs.readFileSync(c.abs, 'utf8')
  log(`${c.name} second write-back ${JSON.stringify(results[c.name].second)}`)
}
for (const c of CASES) {
  const name = `Rp${c.name.slice(2)}`
  const text = results[c.name].first.replace(`# ${c.name}`, `# ${name}`)
  const abs = path.join(state.vaultPath, `${name}.md`)
  fs.writeFileSync(abs, text)
  const note = await byPath(`${name}.md`)
  await page.waitForTimeout(1500)
  const editor = await openNote(note, name)
  await page.waitForTimeout(3000)
  check(`${name} unchanged after open`, fs.readFileSync(abs, 'utf8') === text)
  await typeAtEnd(editor, Q, '?').catch((e) => {
    log(`${name} typeAtEnd error ${e.message.split('\n')[0]}`)
  })
  await page.screenshot({ path: path.join(outDir, `${name}-fresh-parse-edit.png`) })
  results[c.name].fresh = fs.readFileSync(abs, 'utf8')
  log(`${name} fresh-parse write-back ${JSON.stringify(results[c.name].fresh)}`)
}
for (const c of CASES) {
  const r = results[c.name]
  for (const k of ['first', 'second', 'fresh']) {
    check(`${c.name} ${k} javascript tag present (info)`, true, String(/```javascript/.test(r[k])))
  }
  check(`${c.name} first edit lands "!"`, r.first.includes('!'))
  check(`${c.name} second edit bytes (info)`, true, '')
}
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2))
log(`FAILURES ${failures}`)
await browser.close().catch(() => {})
process.exit(failures ? 1 : 0)
