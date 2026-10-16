// memrynote in 90 seconds: what happens on screen in each scene of narration.json.
// ctx: page, rec (glide/click/type/key/center/mark), L, at(phrase, offset), end(), zoom, zoomOn,
// unzoom, caret, sleep. Coordinates are CSS px in the 1600x900 window.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CLI_TASK = 'Ship the style guide'
const NEW_TASK = 'Call Lena about the logo'
const LINK = 'https://www.nngroup.com/articles/ten-usability-heuristics/'
const THOUGHT = 'Case studies as short stories'
const CLI_PROJECT = 'Website Redesign'

/** Runs the real memrynote CLI against the vault the running app has open. */
function memrynote(args, json = false) {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8')
  )
  const electron = createRequire(path.join(ROOT, 'apps/desktop/package.json'))('electron')
  const flags = { high: '3' }
  const out = execFileSync(
    electron,
    [
      '--no-warnings',
      '--experimental-strip-types',
      '--experimental-transform-types',
      path.join(ROOT, 'apps/cli/src/index.ts'),
      '--vault',
      vaultPath,
      '--json',
      ...args.map((a) => flags[a] ?? a)
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }
  )
  return json ? JSON.parse(out) : out
}

/** A full-window layer drawn inside the app, so the recorder films it like any other UI. */
const overlay = (page, html) =>
  page.evaluate((html) => {
    document.getElementById('__demo_layer')?.remove()
    const d = document.createElement('div')
    d.id = '__demo_layer'
    d.innerHTML = html
    document.documentElement.appendChild(d)
  }, html)
const clearOverlay = (page) =>
  page.evaluate(() => {
    const d = document.getElementById('__demo_layer')
    if (!d) return
    d.style.transition = 'opacity .35s'
    d.style.opacity = '0'
    setTimeout(() => d.remove(), 400)
  })

const CANVAS_CARDS = ['Finalize homepage hero', 'Mobile navigation', 'Homepage Ideas']

/** The newest board file in the open vault: its live (not deleted) elements. */
function canvasElements() {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8')
  )
  const dir = path.join(vaultPath, 'canvases')
  const [file] = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.excalidraw'))
    .map((n) => path.join(dir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return JSON.parse(fs.readFileSync(file, 'utf8')).elements.filter((e) => !e.isDeleted)
}
/** The board's cards in CANVAS_CARDS order. */
const canvasCards = () => {
  const cards = canvasElements().filter((e) => e.customData?.entityType)
  return [cards[0], cards[1], cards.find((c) => c.customData.entityType === 'note')]
}
/** Board units -> viewport px, anchored on the note card, the one card the DOM renders. */
async function boardToScreen(page) {
  const note = canvasCards()[2]
  const box = await page
    .locator('h3')
    .filter({ hasText: /^Homepage Ideas$/ })
    .first()
    .evaluate((e) => {
      let c = e
      while (c && c.getBoundingClientRect().height < 80) c = c.parentElement
      const r = c.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width }
    })
  const z = box.w / note.width
  return (x, y) => ({ x: box.x + (x - note.x) * z, y: box.y + (y - note.y) * z })
}

const FONT = `font-family: ui-sans-serif, -apple-system, 'SF Pro Text', sans-serif;`
const TERMINAL = `
<style>
  @keyframes __in { from { opacity: 0; transform: translateY(24px) scale(.97) } to { opacity: 1; transform: none } }
  @keyframes __blink { 50% { opacity: 0 } }
  #__term { position: fixed; right: 48px; bottom: 48px; width: 760px; z-index: 2147483600;
    background: #17130f; color: #f3e9df; border-radius: 14px; overflow: hidden;
    box-shadow: 0 30px 80px rgba(0,0,0,.35); animation: __in .4s cubic-bezier(.2,.8,.2,1) both; ${FONT} }
  #__term .bar { display: flex; gap: 8px; padding: 14px 16px; background: #221c16 }
  #__term .bar i { width: 12px; height: 12px; border-radius: 50%; display: block }
  #__term pre { margin: 0; padding: 22px 24px 26px; font: 19px/1.6 ui-monospace, 'SF Mono', Menlo, monospace; white-space: pre-wrap }
  #__term .p { color: #ec7840 } #__term .ok { color: #7fd18b } #__term .c { animation: __blink 1s step-end infinite }
</style>
<div id="__term"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
<pre><span class="p">~ $</span> <span id="__cmd"></span><span class="c">▍</span>
<span id="__out"></span></pre></div>`

const SYNC = `
<style>
  @keyframes __fade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes __pop { from { opacity: 0; transform: translateY(30px) scale(.9) } to { opacity: 1; transform: none } }
  @keyframes __dash { to { stroke-dashoffset: -40 } }
  #__sync { position: fixed; inset: 0; z-index: 2147483600; background: #fbf7f2; display: flex;
    flex-direction: column; align-items: center; justify-content: center; gap: 56px;
    animation: __fade .35s ease both; ${FONT} color: #1d1813 }
  #__sync .row { display: flex; align-items: center; gap: 28px }
  #__sync .dev { display: flex; flex-direction: column; align-items: center; gap: 14px;
    font-size: 20px; font-weight: 600; animation: __pop .5s cubic-bezier(.2,.8,.2,1) both }
  #__sync .lock { width: 132px; height: 132px; border-radius: 36px; background: #ec7840; display: grid;
    place-items: center; box-shadow: 0 20px 50px rgba(236,120,64,.45); animation: __pop .5s .5s cubic-bezier(.2,.8,.2,1) both }
  #__sync svg.link path { stroke: #ec7840; stroke-width: 4; stroke-dasharray: 10 10; fill: none; animation: __dash .8s linear infinite }
  #__sync h1 { margin: 0; font-size: 54px; letter-spacing: -.02em; animation: __pop .5s 1.1s both }
  #__sync p { margin: -36px 0 0; font-size: 22px; color: #7a6b5e; animation: __pop .5s 1.4s both }
</style>
<div id="__sync">
  <div class="row">
    <div class="dev" style="animation-delay:.1s">
      <svg width="190" height="130" viewBox="0 0 190 130"><rect x="15" y="6" width="160" height="100" rx="10" fill="#1d1813"/><rect x="23" y="14" width="144" height="84" rx="4" fill="#fff3e8"/><rect x="0" y="108" width="190" height="12" rx="6" fill="#3a3129"/></svg>Mac</div>
    <svg class="link" width="120" height="20"><path d="M0 10 H120"/></svg>
    <div class="lock"><svg width="64" height="72" viewBox="0 0 64 72"><rect x="4" y="30" width="56" height="40" rx="9" fill="#fff"/><path d="M16 30 V20 a16 16 0 0 1 32 0 V30" stroke="#fff" stroke-width="8" fill="none"/><circle cx="32" cy="50" r="6" fill="#ec7840"/></svg></div>
    <svg class="link" width="120" height="20"><path d="M0 10 H120"/></svg>
    <div class="dev" style="animation-delay:.25s">
      <svg width="80" height="130" viewBox="0 0 80 130"><rect x="2" y="2" width="76" height="126" rx="16" fill="#1d1813"/><rect x="8" y="10" width="64" height="110" rx="10" fill="#fff3e8"/></svg>iPhone</div>
    <div class="dev" style="animation-delay:.4s">
      <svg width="170" height="130" viewBox="0 0 170 130"><rect x="2" y="10" width="166" height="110" rx="10" fill="#1d1813"/><rect x="10" y="18" width="150" height="94" rx="4" fill="#fff3e8"/></svg>Windows &amp; Linux</div>
  </div>
  <h1>End-to-end encrypted.</h1>
  <p>Your keys stay on your devices. The server only ever sees ciphertext.</p>
</div>`

/** Start state: Tasks, all projects, list view, day panel closed, Agent chat on Haiku, low effort. */
export async function setup({ page, L, sleep }) {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click()
  await sleep(900)
  if (!(await L('[aria-label="Resize Day Panel"]').count()))
    await L('[aria-label="Day Panel"]').click()
  await sleep(600)
  // Agent chat (a tab in the day panel) answers in about 6 s on Haiku at low effort; the default (Opus, extra high) takes
  // far longer than a scene.
  await L('[aria-label="Agent"]').click()
  await sleep(800)
  const enable = page.getByRole('button', { name: 'Enable Agent chat' })
  if (await enable.count()) await enable.click()
  await sleep(1500)
  await page.getByText(/ · /).filter({ hasText: /Opus|Sonnet|Haiku/ }).first().click()
  await sleep(400)
  await page.getByRole('menuitem', { name: /^Model/ }).hover()
  await sleep(400)
  await page.getByRole('menuitem', { name: 'Haiku', exact: true }).first().click()
  await sleep(400)
  await page.getByText(/ · /).filter({ hasText: /Haiku/ }).first().click()
  await sleep(400)
  await page.getByRole('menuitem', { name: /^Effort/ }).hover()
  await sleep(400)
  await page.getByRole('menuitem', { name: 'Low', exact: true }).click()
  await sleep(400)
  await page.keyboard.press('Escape')
  // Back to the Day tab, so the journal scene opens the panel on the calendar, then close it.
  await L('[aria-label="Day"]').click()
  await sleep(400)
  await L('[aria-label="Day Panel"]').click()
  await sleep(800)
  // Opening the day panel in a narrow window folds the sidebar away; bring it back.
  if (!(await page.getByRole('button', { name: 'Search or jump to…' }).isVisible()))
    await L('[aria-label="Toggle Sidebar"]').first().click()
  await sleep(500)
}

const nav = (page, name) => page.getByRole('button', { name, exact: true }).first()

export const scenes = {
  async intro({ rec }) {
    await rec.glide(760, 300, 600)
  },

  async capture({ page, rec, at, zoom, unzoom, L, sleep }) {
    await rec.click(page.getByPlaceholder(/Add a task/).first(), { dx: -250, pause: 60 })
    zoom(760, 60, 1.9)
    await rec.type(NEW_TASK, { cps: 26 })
    await at('Date', -0.2)
    await rec.type(' @tod', { cps: 22 })
    await sleep(150)
    await rec.key('Tab')
    await at('priority', -0.1)
    await rec.type(' !h', { cps: 22 })
    await sleep(150)
    await rec.key('Tab')
    await at('project', -0.1)
    await rec.type(' +webs', { cps: 22 })
    await sleep(200)
    await rec.key('Tab')
    await at('Done', -0.1)
    await rec.key('Enter')
    unzoom()
    // Show the new row: it lands in Today, which the list scrolls to.
    await sleep(400)
    const row = page.getByText(NEW_TASK, { exact: true }).first()
    await row.waitFor({ timeout: 4000 })
    await row.scrollIntoViewIfNeeded()
    await rec.glide(...Object.values(await rec.center(row)), 450)
    await at('Then drag', -0.5)
    await rec.click(L('[aria-label="Day Panel"]'), { pause: 40 })
    await sleep(500)
    // The day panel lists today's undated-time tasks under Unscheduled; drag ours onto 2 PM.
    const src = await rec.center(page.getByText(NEW_TASK, { exact: true }).last())
    const slot = await rec.center(page.getByText('2 PM', { exact: true }).first())
    await rec.glide(src.x, src.y, 350)
    rec.mark('drag-start')
    await page.mouse.down()
    await sleep(100)
    await rec.glide(src.x - 10, src.y - 6, 100)
    await rec.glide(slot.x + 120, slot.y + 10, 700)
    await sleep(150)
    await page.mouse.up()
    rec.mark('drag-end')
  },

  async inbox({ page, rec, at, zoom, unzoom, sleep }) {
    await rec.click(nav(page, 'Inbox'), { pause: 60 })
    await sleep(400)
    const capture = page.getByPlaceholder(/Quick capture/).first()
    await rec.click(capture, { dx: -200, pause: 40 })
    zoom(800, 160, 1.4)
    rec.mark('paste')
    await page.keyboard.insertText(LINK)
    await sleep(200)
    await rec.key('Enter')
    await at('drop a thought', -0.4)
    await rec.click(capture, { dx: -200, pause: 30 })
    await rec.type(THOUGHT, { cps: 30 })
    await rec.key('Enter')
    await at('triage it', -0.3)
    unzoom()
    // Each item opens in the detail panel; rows reorder as items arrive, so wait for the row
    // to settle, then wait for the panel to show the item before acting on it.
    const open = async (row) => {
      await sleep(300)
      await rec.click(row, { pause: 40 })
      await page.getByRole('button', { name: 'Close panel' }).waitFor({ timeout: 3000 })
      await sleep(250)
    }
    await open(page.getByText(/Usability Heuristics/).first())
    await at('becomes a note', -0.2)
    // The "Item captured" toast sits over the File button; its shortcut files the same way.
    await rec.key('Meta+Enter')
    await sleep(500)
    await open(page.getByText(THOUGHT, { exact: true }).first())
    await at('a task', -0.4)
    await rec.click(
      page.getByRole('button', { name: 'Task', exact: true }).or(page.getByText('Task', { exact: true })).last(),
      { pause: 40 }
    )
    await sleep(300)
    // The toast from the previous filing covers "Add task", and the form has no ⌘⏎: glide to
    // the button's visible edge, then press it from the keyboard.
    const add = page.getByRole('button', { name: 'Add task', exact: true })
    await rec.glide(...Object.values(await rec.center(add)), 300)
    await add.focus()
    await rec.key('Enter')
  },

  async notes({ page, rec, at, zoom, caret, sleep }) {
    const lb = await page.getByText('Next steps', { exact: true }).boundingBox()
    await rec.glide(lb.x + lb.width + 4, lb.y + lb.height / 2, 400)
    rec.mark('click')
    await page.mouse.down()
    await page.mouse.up()
    await rec.key('End')
    await rec.key('Enter')
    const c = await caret()
    zoom(lb.x + 260, c.y + 60, 1.6)
    await at('Slash', -0.1)
    await rec.type('/', { cps: 10 })
    // Show the menu, then close it: a check list here would turn the task line below into a
    // plain checkbox instead of a task.
    await sleep(900)
    await rec.key('Escape')
    await rec.key('Backspace')
    await at('brackets', -0.2)
    await rec.type('Mobile first, see [[Design Pri', { cps: 30 })
    await sleep(400)
    await rec.key('Enter')
  },

  async tasknote({ page, rec, at, sleep }) {
    await rec.key('Enter')
    await rec.type('[ ] ', { cps: 12 })
    await sleep(150)
    await rec.type('Send the hero to Jonas @tomorrow !h', { cps: 26 })
    await at('right where', -0.5)
    // The first Escape closes the date suggestions, the second leaves the title: the markers
    // become chips, and no empty task row opens below.
    await rec.key('Escape')
    await sleep(150)
    await rec.key('Escape')
  },

  async today({ page, rec, at, zoom, sleep }) {
    await at('Today shows', 0.2)
    const r = await rec.center(page.getByText('Reply to Jonas about the workshop', { exact: true }))
    zoom(900, r.y, 1.45)
    await at('Check it off', -0.8)
    await rec.click(
      page
        .getByRole('checkbox', { name: 'Select Reply to Jonas about the workshop' })
        .locator('xpath=following::button[starts-with(@aria-label,"Status:")][1]'),
      { pause: 60 }
    )
    await sleep(250)
    await rec.click(
      page
        .getByRole('menuitem', { name: 'Done' })
        .or(page.getByRole('option', { name: 'Done' }))
        .first(),
      { pause: 60 }
    )
  },

  async projects({ page, rec, at, L, sleep }) {
    await at('Projects pull', 0.1)
    await rec.click(L('[aria-label="Kanban view"]'), { pause: 60 })
    await sleep(500)
    await at('Drag a card', -0.6)
    const c = await rec.center(page.getByText('Build style guide page', { exact: true }).first())
    const d = await rec.center(page.getByText('Mobile navigation', { exact: true }).first())
    await rec.glide(c.x, c.y, 400)
    rec.mark('drag-start')
    await page.mouse.down()
    await sleep(100)
    await rec.glide(c.x + 12, c.y + 6, 100)
    await rec.glide(d.x, d.y + 60, 700)
    await sleep(150)
    await page.mouse.up()
    rec.mark('drag-end')
    await sleep(300)
    await rec.glide(...Object.values(await rec.center(page.getByText(CLI_TASK, { exact: true }).first())), 600)
  },

  async journal({ page, rec, at, L, sleep }) {
    await rec.click(nav(page, 'Journal'), { pause: 60 })
    await at('journal page', -0.2)
    await rec.click(L('[aria-label="Day Panel"]'), { pause: 60 })
  },

  async search({ page, rec, at, sleep }) {
    await rec.click(page.getByRole('button', { name: 'Search or jump to…' }), { pause: 60 })
    await sleep(200)
    await rec.type('lisbon', { cps: 16 })
    await at('Then see', -0.6)
    await rec.key('Escape')
    await rec.click(nav(page, 'Graph'), { pause: 60 })
  },

  async canvas({ page, rec, at, zoom, sleep }) {
    for (const q of CANVAS_CARDS) {
      await rec.click(page.getByRole('button', { name: 'Add card' }), { pause: 40 })
      await sleep(200)
      await rec.type(q.slice(0, 14), { cps: 34 })
      // Results load after the "Create note" row; pick the item itself, never the create row.
      const hit = page.getByRole('dialog').getByText(q, { exact: true }).first()
      await hit.waitFor({ timeout: 4000 })
      await rec.click(hit, { pause: 30 })
      await sleep(300)
    }
    // Task cards are drawn on the canvas, not in the DOM: place them from the board file,
    // using the note card (a DOM card) to map board units to screen pixels.
    // The board file is written a moment after the last card lands.
    for (let i = 0; i < 30 && canvasElements().filter((e) => e.customData?.entityType).length < 3; i++)
      await sleep(100)
    const S = await boardToScreen(page)
    const [h, n, d] = canvasCards()
    // Frame the three cards, so the arrows read at film size.
    const mid = S((h.x + d.x + d.width) / 2, (h.y + d.y + d.height) / 2)
    zoom(mid.x, mid.y, 1.9)
    await at('connect them', -0.6)
    const arrow = async (a, b) => {
      await rec.click(page.locator('label[title^="Arrow"]'), { pause: 30 })
      await page.locator('.color-picker__button[title="#f08c00"]').first().click()
      await rec.glide(a.x, a.y, 300)
      await page.mouse.down()
      await rec.glide(b.x, b.y, 450)
      await page.mouse.up()
      await sleep(150)
      await rec.key('Escape')
    }
    // From each task's middle to the note: both ends bind, so the arrows are real links.
    await arrow(S(h.x + h.width / 2, h.y + h.height / 2), S(d.x + d.width * 0.3, d.y + d.height / 2))
    await arrow(S(n.x + n.width / 2, n.y + n.height / 2), S(d.x + d.width * 0.7, d.y + d.height / 2))
    // Back to the selection tool and off the arrow, so its style panel closes.
    await rec.key('1')
    const top = S(d.x, h.y - 120)
    await rec.glide(top.x, top.y, 300)
    await page.mouse.down()
    await page.mouse.up()
  },

  async ai({ page, rec, at, L, zoom, sleep }) {
    await rec.click(L('[aria-label="Day Panel"]'), { pause: 60 })
    await sleep(300)
    await rec.click(L('[aria-label="Agent"]'), { pause: 60 })
    await sleep(500)
    await rec.click(
      page.locator('[data-placeholder^="Do anything"], [placeholder^="Do anything"]').first(),
      { pause: 60 }
    )
    zoom(1420, 420, 1.6)
    await rec.type("What's due today?", { cps: 24 })
    await rec.key('Enter')
  },

  async cli({ page, rec, at, sleep }) {
    await overlay(page, TERMINAL)
    const shown = `memrynote tasks create "${CLI_TASK}" --project "${CLI_PROJECT}" --priority high`
    await sleep(350)
    for (const ch of shown) {
      await page.evaluate((ch) => (document.getElementById('__cmd').textContent += ch), ch)
      await sleep(14)
    }
    // The CLI takes a project id; the board in the next scene loads it fresh.
    const project = memrynote(['projects', 'list'], true).find((p) => p.name === CLI_PROJECT)
    memrynote(['tasks', 'create', CLI_TASK, '--project', project.id, '--priority', 'high'])
    await page.evaluate(
      (t) =>
        (document.getElementById('__out').innerHTML =
          `<span class="ok">✓</span> Created task "${t}"\n<span class="p">~ $</span> <span style="opacity:.6">claude mcp add memrynote …</span>`),
      CLI_TASK
    )
    await at('writing straight', 0.4)
  },

  async sync({ page }) {
    await overlay(page, SYNC)
  },

  async outro({ page, rec }) {
    await clearOverlay(page)
    await rec.glide(800, 450, 1200)
  }
}

/** Runs after a scene's narration has ended, before the next scene starts. */
export const after = {
  async today({ unzoom }) {
    unzoom()
  },
  async capture({ page, L, rec, sleep }) {
    await sleep(500)
    await rec.click(L('[aria-label="Day Panel"]'), { pause: 40 })
    await sleep(300)
    // Opening the day panel folds the sidebar away in this window size; the next scenes need it.
    if (!(await page.getByRole('button', { name: 'Search or jump to…' }).isVisible()))
      await rec.click(L('[aria-label="Browser forward"]'), { dx: 30, pause: 40 })
    await sleep(300)
  },
  async inbox({ page, rec, sleep }) {
    await sleep(600)
    await rec.click(page.getByRole('button', { name: 'Search or jump to…' }), { pause: 60 })
    await sleep(200)
    await rec.type('Homepage', { cps: 30 })
    // Enter before the result lands opens nothing, and the next scene would type into the Inbox.
    await page.getByRole('option', { name: /Homepage Ideas/ }).first().waitFor({ timeout: 4000 })
    await sleep(150)
    await rec.key('Enter')
    await page.getByText('Next steps', { exact: true }).waitFor({ state: 'visible', timeout: 4000 })
    await sleep(400)
  },
  async tasknote({ page, rec, unzoom, sleep }) {
    unzoom()
    await rec.click(nav(page, 'Tasks'), { pause: 60 })
    await sleep(500)
  },
  async cli({ page, rec, sleep }) {
    await clearOverlay(page)
    await sleep(300)
    await rec.click(page.getByRole('combobox', { name: 'Select project' }), { pause: 60 })
    await sleep(300)
    await rec.click(page.getByRole('option', { name: /Website Redesign/ }).first(), { pause: 60 })
    await sleep(300)
  },
  async journal({ L, rec, sleep }) {
    await rec.click(L('[aria-label="Day Panel"]'), { pause: 60 })
    await sleep(300)
  },
  async canvas({ unzoom }) {
    unzoom()
  },
  async search({ page, rec, sleep }) {
    const sec = page.getByText(/^Canvases$/i).first()
    await rec.glide(...Object.values(await rec.center(sec)), 400)
    await sleep(250)
    await rec.click(page.getByRole('button', { name: 'New canvas' }).first(), { pause: 60 })
    await sleep(600)
    // A new board opens at 200%; at 50% the three cards and their arrows fit.
    for (let i = 0; i < 5; i++) {
      await rec.click(page.getByRole('button', { name: 'Zoom out' }), { pause: 20 })
    }
    await sleep(200)
  },
  async ai({ page, rec, L, unzoom, sleep }) {
    // The line is over and the agent may still be thinking: fast-forward the wait, marked on
    // screen, then show the finished answer at normal speed.
    const thinking = page.getByText(/Agent is thinking/)
    const settled = async () => {
      if (await thinking.count()) return false
      const a = await page.evaluate(() => document.body.innerText.length)
      await sleep(700)
      return a === (await page.evaluate(() => document.body.innerText.length))
    }
    if (!(await settled())) {
      await page.evaluate(() => {
        const b = document.createElement('div')
        b.id = '__demo_ff'
        b.textContent = '⏩ 5×'
        Object.assign(b.style, {
          position: 'fixed', top: '170px', right: '40px', zIndex: 2147483600,
          padding: '6px 12px', borderRadius: '999px', background: '#17130f', color: '#fff',
          font: '600 15px ui-sans-serif, -apple-system, sans-serif'
        })
        document.documentElement.appendChild(b)
      })
      rec.speed(5)
      const until = Date.now() + 40_000
      while (!(await settled())) {
        if (Date.now() > until) throw new Error('Agent chat gave no answer within 40 s')
      }
      rec.speedEnd()
      await page.evaluate(() => document.getElementById('__demo_ff')?.remove())
    }
    await sleep(2500)
    unzoom()
    await rec.click(L('[aria-label="Day"]'), { pause: 60 })
    await rec.click(L('[aria-label="Day Panel"]'), { pause: 60 })
    await sleep(300)
  }
}

/** What the recording must have written. Each check returns an error string or nothing. */
export const checks = [
  [
    'Quick capture parsed every marker',
    (q) => {
      const [t] = q(`SELECT t.due_date, t.priority, p.name AS project FROM tasks t
        JOIN projects p ON p.id = t.project_id WHERE t.title = '${NEW_TASK}'`)
      if (!t || t.project !== 'Website Redesign' || t.priority !== 3 || !t.due_date)
        return JSON.stringify(t)
    }
  ],
  [
    'Task dragged onto the day',
    (q) => {
      const [t] = q(`SELECT due_time FROM tasks WHERE title = '${NEW_TASK}'`)
      if (!t?.due_time) return JSON.stringify(t)
    }
  ],
  [
    'Inbox triaged: link to a note, thought to a task',
    (q) => {
      const rows = q(`SELECT title, filed_action FROM inbox_items`)
      const [task] = q(`SELECT id FROM tasks WHERE title = '${THOUGHT}'`)
      if (
        rows.length !== 2 ||
        !rows.some((r) => r.filed_action === 'task') ||
        !rows.some((r) => r.filed_action === 'folder') ||
        !task
      )
        return JSON.stringify(rows)
    }
  ],
  [
    'Canvas cards joined by two arrows',
    () => {
      const arrows = canvasElements().filter((e) => e.type === 'arrow')
      if (arrows.length !== 2 || arrows.some((a) => !a.startBinding || !a.endBinding))
        return JSON.stringify(arrows.map((a) => [!!a.startBinding, !!a.endBinding]))
    }
  ],
  [
    'Checkbox in the note became a task',
    (q) => {
      const [t] = q(`SELECT priority, due_date FROM tasks WHERE title = 'Send the hero to Jonas'`)
      if (!t || t.priority !== 3 || !t.due_date) return JSON.stringify(t)
    }
  ],
  [
    'Checked off in Today',
    (q) => {
      const [t] = q(`SELECT s.name FROM tasks t JOIN statuses s ON s.id = t.status_id
        WHERE t.title = 'Reply to Jonas about the workshop'`)
      if (t?.name !== 'Done') return JSON.stringify(t)
    }
  ],
  [
    'Card moved to Design',
    (q) => {
      const [t] = q(`SELECT s.name FROM tasks t JOIN statuses s ON s.id = t.status_id
        WHERE t.title = 'Build style guide page'`)
      if (t?.name !== 'Design') return JSON.stringify(t)
    }
  ],
  [
    'CLI task landed in the vault',
    (q) => {
      const [t] = q(`SELECT p.name, t.priority FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.title = '${CLI_TASK}'`)
      if (t?.name !== CLI_PROJECT || t.priority !== 3) return JSON.stringify(t)
    }
  ]
]
