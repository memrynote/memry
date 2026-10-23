// memrynote at a glance: one idea followed from the inbox to the graph. What happens on screen
// in each scene of narration.json.
// ctx: page, rec (glide/click/type/key/center/mark), L, at(phrase, offset), end(), zoom, zoomOn,
// unzoom, caret, sleep. Coordinates are CSS px in the 1600x900 window.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const LINK = 'https://www.nngroup.com/articles/ten-usability-heuristics/'
const LINK_TITLE = '10 Usability Heuristics for User Interface Design'
const IDEA = 'Case studies as short stories'
const TASK = 'Draft the first case study'
const NEW_TASK = 'Call Lena about the logo'
/** Each card, what to type for it in Add card, and the words that bring it in. */
const CANVAS_CARDS = [
  ['Studio North Kickoff', 'Studio No', 'the kickoff'],
  [IDEA, 'Case studies', 'the idea'],
  [TASK, 'Draft the f', 'its task']
]

const day = (offset = 0) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The vault the running app has open: agent-app copies the tutorial vault for each run. */
const vaultPath = () =>
  JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8')).vaultPath
const vaultText = (rel) => {
  const f = path.join(vaultPath(), rel)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

/** The newest board file in the open vault: its live (not deleted) elements. */
function canvasElements() {
  const dir = path.join(vaultPath(), 'canvases')
  const [file] = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.excalidraw'))
    .map((n) => path.join(dir, n))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return JSON.parse(fs.readFileSync(file, 'utf8')).elements.filter((e) => !e.isDeleted)
}
/**
 * The open board's cards in viewport px, in the order CANVAS_CARDS added them. The board
 * file lags the editor by its autosave, so ask the Excalidraw API, which canvas-editor.tsx
 * keeps in a hook.
 */
const liveCards = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.excalidraw')
    const isApi = (v) =>
      typeof v?.getSceneElements === 'function' && typeof v.getAppState === 'function'
    const fiber = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
    let api = null
    for (let f = el[fiber]; f && !api; f = f.return)
      for (let h = f.memoizedState; h && !api && typeof h === 'object' && 'next' in h; h = h.next)
        api = isApi(h.memoizedState)
          ? h.memoizedState
          : isApi(h.memoizedState?.current)
            ? h.memoizedState.current
            : null
    const s = api.getAppState()
    const z = s.zoom.value
    return api
      .getSceneElements()
      .filter((e) => e.customData?.entityType)
      .map((e) => ({
        x: (e.x + s.scrollX) * z + s.offsetLeft,
        y: (e.y + s.scrollY) * z + s.offsetTop,
        w: e.width * z,
        h: e.height * z
      }))
  })

/** Viewport point of a graph node. Sigma draws the nodes in WebGL, so ask its renderer. */
const graphNode = (page, label) =>
  page.evaluate((label) => {
    const el = document.querySelector('.sigma-container')
    const isSigma = (v) => v && typeof v === 'object' && typeof v.graphToViewport === 'function'
    const seen = new Set()
    const scan = (v, depth) => {
      if (!v || typeof v !== 'object' || seen.has(v) || depth > 4) return null
      seen.add(v)
      if (isSigma(v)) return v
      for (const k of ['memoizedState', 'memoizedProps', 'next', 'queue', 'baseState', 'current']) {
        const r = scan(v[k], depth + 1)
        if (r) return r
      }
      return null
    }
    const fiber = Object.keys(el).find((k) => k.startsWith('__reactFiber'))
    let sigma = null
    for (let f = el[fiber]; f && !sigma; f = f.return)
      sigma = scan(f.memoizedState, 0) || scan(f.memoizedProps, 0)
    const graph = sigma.getGraph()
    const node = graph.findNode((_, a) => a.label === label)
    const p = sigma.graphToViewport(graph.getNodeAttributes(node))
    const r = sigma.getContainer().getBoundingClientRect()
    return { x: r.x + p.x, y: r.y + p.y }
  }, label)

/** Viewport point just after the last character of a block, where a click puts the caret. */
const endOf = (locator) =>
  locator.evaluate((el) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n, last
    while ((n = walk.nextNode())) if (n.textContent.trim()) last = n
    const r = document.createRange()
    r.setStart(last, last.length - 1)
    r.setEnd(last, last.length)
    const b = r.getBoundingClientRect()
    return { x: b.right + 1, y: b.y + b.height / 2 }
  })

/** The hour label in the middle of the day panel's visible timeline, whatever time it is. */
const midHour = (page) =>
  page.evaluate(() => {
    const labels = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && /^\d{1,2} (AM|PM)$/.test(e.textContent.trim())
    )
    const visible = labels.filter((e) => {
      let p = e.parentElement
      while (p && !/(auto|scroll)/.test(getComputedStyle(p).overflowY)) p = p.parentElement
      const a = e.getBoundingClientRect()
      const b = p?.getBoundingClientRect()
      return b && a.top >= b.top && a.bottom <= b.bottom
    })
    const r = visible[Math.floor(visible.length / 2)].getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })

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
    setTimeout(() => {
      d.remove()
    }, 400)
  })

const FONT = `font-family: ui-sans-serif, -apple-system, 'SF Pro Text', sans-serif;`
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

const nav = (page, name) => page.getByRole('button', { name, exact: true }).first()
/** The one on-screen copy of a title: inactive tabs stay mounted, hidden. */
const shown = (page, text) => page.getByText(text, { exact: true }).filter({ visible: true })

/** Opening the day panel can fold the sidebar away in this window size; bring it back. */
async function ensureSidebar(page, L, rec) {
  if (await page.getByRole('button', { name: 'Search or jump to…' }).isVisible()) return
  // The unlabeled toggle sits just right of the forward button.
  await rec.click(L('[aria-label="Browser forward"]'), { dx: 30, pause: 40 })
  await page.waitForTimeout(300)
}

async function toggleDayPanel(page, L, rec) {
  await rec.click(L('[aria-label="Day Panel"]'), { pause: 40 })
  await page.waitForTimeout(400)
}

/** Start state: an empty Inbox, day panel closed, sidebar open. */
export async function setup({ page, L, sleep }) {
  await page.keyboard.press('Escape')
  // A page's first visit shows a spinner while it loads; take those visits off camera.
  for (const name of ['Tasks', 'Journal', 'Graph']) {
    await nav(page, name).click()
    await sleep(1500)
  }
  await nav(page, 'Inbox').click()
  await sleep(900)
  if (await L('[aria-label="Resize Day Panel"]').count())
    await L('[aria-label="Day Panel"]').click()
  await sleep(500)
  if (!(await page.getByRole('button', { name: 'Search or jump to…' }).isVisible()))
    await page.mouse.click(148, 13)
  await sleep(500)
}

export const scenes = {
  async intro({ page, rec }) {
    // The title card covers this scene; park the cursor where the capture starts.
    const c = await rec.center(page.getByPlaceholder(/Quick capture/).first())
    await rec.glide(c.x - 200, c.y, 600)
  },

  async inbox({ page, rec, at, zoom, sleep }) {
    const capture = page.getByPlaceholder(/Quick capture/).first()
    await rec.click(capture, { dx: -200, pause: 40 })
    zoom(800, 160, 1.4)
    rec.mark('paste')
    await page.keyboard.insertText(LINK)
    await sleep(200)
    await rec.key('Enter')
    await at('drop a thought', -0.4)
    await rec.click(capture, { dx: -200, pause: 30 })
    await rec.type(IDEA, { cps: 30 })
    await rec.key('Enter')
  },

  async triage({ page, rec, at, unzoom, sleep }) {
    unzoom()
    // Rows reorder as items arrive: let the row settle, then wait for its panel to open.
    const open = async (row) => {
      await sleep(300)
      await rec.click(row, { pause: 40 })
      await page.getByRole('button', { name: 'Close panel' }).waitFor({ timeout: 3000 })
      await sleep(250)
    }
    // The "Item captured" and "Filed" toasts sit over the File button; ⌘⏎ files the same way.
    const file = async () => {
      await rec.glide(
        ...Object.values(await rec.center(page.getByRole('button', { name: /^File to / }))),
        300
      )
      await rec.key('Meta+Enter')
      await sleep(500)
    }
    // The row shows the URL's slug until the page's own title arrives, and the note is
    // filed under whichever title the row has. Filing early names it after the slug.
    await page
      .getByText(LINK_TITLE, { exact: true })
      .first()
      .waitFor({ timeout: 12000 })
      .catch(() => {
        throw new Error(`The link never resolved to "${LINK_TITLE}"; the fetch is slow, re-run`)
      })
    await open(page.getByText(LINK_TITLE, { exact: true }).first())
    await at('The link is filed', -0.4)
    await file()
    await open(page.getByText(IDEA, { exact: true }).first())
    await at('the idea becomes', -0.3)
    // Note is already the convert target; the click shows where the choice lives.
    await rec.click(page.getByText('Note', { exact: true }).last(), { pause: 40 })
    await file()
  },

  async note({ page, rec, at, zoom, caret, sleep }) {
    await rec.click(page.getByRole('button', { name: 'Search or jump to…' }), { pause: 60 })
    await sleep(150)
    await rec.type('Case stu', { cps: 36 })
    const hit = page.getByRole('option', { name: new RegExp(IDEA) }).first()
    await hit.waitFor({ timeout: 4000 })
    await rec.click(hit, { pause: 40 })
    const title = page.locator('[contenteditable=true]').getByText(IDEA, { exact: true }).first()
    await title.waitFor({ timeout: 4000 })
    await sleep(400)
    const e = await endOf(title)
    await rec.glide(e.x, e.y, 350)
    rec.mark('click')
    await page.mouse.down()
    await page.mouse.up()
    await sleep(150)
    await rec.key('Enter')
    const box = await title.boundingBox()
    const c = await caret()
    zoom(box.x + 300, c.y + 40, 1.6)
    await rec.type('Start with Studio North, see ', { cps: 28 })
    await at('Two brackets', -0.2)
    await rec.type('[[10 Usa', { cps: 18 })
    await sleep(450)
    await rec.key('Enter')
  },

  async tasknote({ rec, at, sleep }) {
    await rec.key('Enter')
    await rec.type('[ ] ', { cps: 12 })
    await sleep(150)
    await rec.type(`${TASK} @today !h`, { cps: 26 })
    await at('right where', -0.5)
    // The first Escape closes the date suggestions, the second leaves the title: the markers
    // become chips, and no empty task row opens below.
    await rec.key('Escape')
    await sleep(150)
    await rec.key('Escape')
  },

  async manage({ page, rec, at, zoom, unzoom, L, sleep }) {
    unzoom()
    await rec.click(nav(page, 'Tasks'), { pause: 60 })
    const row = shown(page, TASK).first()
    await row.waitFor({ timeout: 4000 })
    await row.scrollIntoViewIfNeeded()
    const r = await rec.center(row)
    await rec.glide(r.x, r.y, 450)
    zoom(900, r.y, 1.45)
    await at('Drag it', -0.9)
    unzoom()
    await toggleDayPanel(page, L, rec)
    // The day panel lists today's tasks without a time under Unscheduled; drop ours on the
    // middle of the visible timeline, so it lands in view whatever time the shoot runs.
    const src = await rec.center(shown(page, TASK).last())
    const slot = await midHour(page)
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

  async newtask({ page, rec, at, zoom, unzoom, L, sleep }) {
    // The calendar is done for now; the sidebar stays folded until the canvas needs it.
    await toggleDayPanel(page, L, rec)
    const capture = page.getByPlaceholder(/Add a task/).first()
    await rec.click(capture, { dx: -250, pause: 60 })
    const field = await capture.boundingBox()
    zoom(field.x + 380, field.y + 50, 1.8)
    await rec.type(NEW_TASK, { cps: 26 })
    await at('Date', -0.2)
    await rec.type(' @tom', { cps: 22 })
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
    // Show the new row where it landed.
    await sleep(400)
    const row = shown(page, NEW_TASK).first()
    await row.waitFor({ timeout: 4000 })
    await row.scrollIntoViewIfNeeded()
    await rec.glide(...Object.values(await rec.center(row)), 450)
  },

  async journal({ page, rec, at, zoom, unzoom, caret, L, sleep }) {
    await rec.click(nav(page, 'Journal'), { pause: 60 })
    const entry = page
      .locator('[contenteditable=true]')
      .getByText(/Client call at 3/)
      .filter({ visible: true })
      .first()
    await entry.waitFor({ timeout: 4000 })
    await sleep(400)
    const e = await endOf(entry)
    await rec.glide(e.x, e.y, 350)
    rec.mark('click')
    await page.mouse.down()
    await page.mouse.up()
    await sleep(150)
    await rec.key('Enter')
    const box = await entry.boundingBox()
    const c = await caret()
    zoom(box.x + 280, c.y + 20, 1.5)
    await rec.type('Started the case studies, see ', { cps: 34 })
    await at('Link the idea', -0.2)
    await rec.type('[[Case stu', { cps: 18 })
    await sleep(450)
    await rec.key('Enter')
    await at('and there', -0.4)
    unzoom()
    await toggleDayPanel(page, L, rec)
    const block = shown(page, TASK).last()
    await block.waitFor({ timeout: 3000 })
    await rec.glide(...Object.values(await rec.center(block)), 500)
  },

  async canvas({ page, rec, at, zoom, sleep }) {
    await rec.glide(...Object.values(await rec.center(page.getByText(/^Canvases/i).first())), 400)
    await sleep(250)
    await rec.click(page.getByRole('button', { name: 'New canvas' }).first(), { pause: 60 })
    await page.getByRole('button', { name: 'Add card' }).waitFor({ timeout: 4000 })
    await sleep(150)
    // A new board opens at 100%; at 70% the three cards and their arrows fit. The cursor
    // is on the button after the first click, so the other two need no glide.
    const zoomOut = page.getByRole('button', { name: 'Zoom out' })
    await rec.click(zoomOut, { pause: 20 })
    for (let i = 0; i < 2; i++) {
      await sleep(90)
      await zoomOut.click()
    }
    for (const [q, typed, words] of CANVAS_CARDS) {
      await at(words, -0.9)
      await rec.click(page.getByRole('button', { name: 'Add card' }), { pause: 30 })
      await sleep(80)
      await rec.type(typed, { cps: 45 })
      const dialog = page.getByRole('dialog')
      const hit = dialog.getByText(q, { exact: true }).first()
      await hit.waitFor({ timeout: 4000 })
      await sleep(100)
      // Enter adds the highlighted match. A note that mentions the title can rank first,
      // and a card already on the board only gets revealed: then pick the item itself.
      const picked = dialog
        .locator('[data-selected=true]')
        .filter({ has: page.getByText(q, { exact: true }) })
      if (await picked.count()) await rec.key('Enter')
      else await rec.click(hit, { pause: 30 })
      await sleep(150)
    }
  },

  async connect({ page, rec, at, zoom, sleep }) {
    const cards = await liveCards(page)
    const [kickoff, idea, task] = cards
    const mid = (c) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 })
    // Frame the three cards, so the arrows read at film size.
    const [x0, x1] = [Math.min(...cards.map((c) => c.x)), Math.max(...cards.map((c) => c.x + c.w))]
    const [y0, y1] = [Math.min(...cards.map((c) => c.y)), Math.max(...cards.map((c) => c.y + c.h))]
    zoom((x0 + x1) / 2, (y0 + y1) / 2, Math.min(1.9, 1400 / (x1 - x0), 760 / (y1 - y0)))
    await at('draw arrows', -0.4)
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
    // Center to center: both ends bind, so each arrow is a real link between the cards.
    await arrow(mid(kickoff), mid(idea))
    await arrow(mid(idea), mid(task))
    // Back to the selection tool and off the arrow, so its style panel closes.
    await rec.key('1')
    await rec.glide(idea.x, Math.min(kickoff.y, idea.y) - 80, 300)
    await page.mouse.down()
    await page.mouse.up()
  },

  async graph({ page, rec, unzoom, sleep }) {
    unzoom()
    await rec.click(nav(page, 'Graph'), { pause: 60 })
    await page.locator('.sigma-container').waitFor({ timeout: 4000 })
    await sleep(900)
    // Hovering the idea lights up everything it links to. Live motion still settles the
    // layout, so aim first, then land on where the node is now.
    let p = await graphNode(page, IDEA)
    await rec.glide(p.x, p.y, 600)
    p = await graphNode(page, IDEA)
    await rec.glide(p.x, p.y, 150)
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
  async journal({ page, rec, L, sleep }) {
    await sleep(300)
    await toggleDayPanel(page, L, rec)
    await ensureSidebar(page, L, rec)
  }
}

/** What the recording must have written. Each check returns an error string or nothing. */
export const checks = [
  [
    'Inbox triaged into two notes',
    (q) => {
      const rows = q(`SELECT title, filed_action FROM inbox_items`)
      if (rows.length !== 2 || rows.some((r) => r.filed_action !== 'folder'))
        return JSON.stringify(rows)
      if (!vaultText(`${LINK_TITLE}.md`) || !vaultText(`${IDEA}.md`)) return 'note files missing'
    }
  ],
  [
    'Idea note links the article and holds the task',
    () => {
      const body = vaultText(`${IDEA}.md`)
      if (!body.includes(`[[${LINK_TITLE}]]`) || !body.includes(`- [ ] ${TASK}`))
        return JSON.stringify(body)
    }
  ],
  [
    'Task from the note is due today, dragged onto the day',
    (q) => {
      const [t] = q(`SELECT priority, due_date, due_time FROM tasks WHERE title = '${TASK}'`)
      if (t?.priority !== 3 || t.due_date !== day() || !t.due_time) return JSON.stringify(t)
    }
  ],
  [
    'Quick capture parsed every marker',
    (q) => {
      const [t] = q(`SELECT t.due_date, t.priority, p.name AS project FROM tasks t
        JOIN projects p ON p.id = t.project_id WHERE t.title = '${NEW_TASK}'`)
      if (t?.project !== 'Website Redesign' || t.priority !== 3 || t.due_date !== day(1))
        return JSON.stringify(t)
    }
  ],
  [
    'Journal links the idea',
    () => {
      const body = vaultText(`journal/${day()}.md`)
      if (!body.includes(`[[${IDEA}]]`)) return JSON.stringify(body)
    }
  ],
  [
    'Canvas joins the cards with two arrows',
    () => {
      const arrows = canvasElements().filter((e) => e.type === 'arrow')
      if (arrows.length !== 2 || arrows.some((a) => !a.startBinding || !a.endBinding))
        return JSON.stringify(arrows.map((a) => [!!a.startBinding, !!a.endBinding]))
    }
  ]
]
