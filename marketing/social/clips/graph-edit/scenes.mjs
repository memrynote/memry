// Graph editing: Ana Costa (a photographer friend in Lisbon) is Option-dragged onto a trip note to
// link them, tagged #lisbon from the right-click menu, dragged to a spot where she stays pinned, and
// the notes-only arrangement is saved as a view. The graph is sigma (WebGL), so node positions come
// from the sigma instance behind the container, read through React's fiber (read only).
import { closeOtherTabs } from '../../engine/kit.mjs'

const SOURCE = 'Ana Costa'
const TARGETS = [
  'Lisbon Itinerary',
  'Sintra day trip',
  'Alfama apartments',
  'Lisbon Ideas',
  'Restaurants to try',
  'Lisbon Packing List',
  'Budget'
]

/** Visible note nodes by label: viewport position and pin state. */
const nodes = (page) =>
  page.evaluate(() => {
    const root = [...document.querySelectorAll('.react-sigma')].find((r) => r.offsetWidth > 300)
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'))
    let sigma
    const stack = [root[key]]
    for (let n = 0; stack.length && !sigma && n < 5000; n++) {
      const f = stack.pop()
      sigma = f?.memoizedProps?.value?.sigma
      if (f?.child) stack.push(f.child)
      if (f?.sibling) stack.push(f.sibling)
    }
    const box = sigma.getContainer().getBoundingClientRect()
    const out = {}
    sigma.getGraph().forEachNode((id, a) => {
      if (a.nodeType !== 'note' || a.isUnresolved) return
      const p = sigma.graphToViewport({ x: a.x, y: a.y })
      out[a.label] = { id, x: box.left + p.x, y: box.top + p.y, pinned: !!a.pinned }
    })
    return out
  })
const pos = async (page, label) => (await nodes(page))[label]

/** Wait until no note moves more than half a pixel between two looks. */
async function settle(page, maxMs = 12000) {
  let last = await nodes(page)
  for (let t = 0; t < maxMs; t += 400) {
    await page.waitForTimeout(400)
    const now = await nodes(page)
    const moved = Math.max(
      ...Object.keys(now).map((k) =>
        last[k] ? Math.hypot(now[k].x - last[k].x, now[k].y - last[k].y) : 99
      )
    )
    if (moved < 0.5) return
    last = now
  }
}

async function setSwitch(page, row, on) {
  const s = page
    .locator('div.flex.items-center.justify-between')
    .filter({ has: page.getByRole('switch') })
    .filter({ hasText: new RegExp(`^${row}$`) })
    .getByRole('switch')
  if ((await s.getAttribute('aria-checked')) !== String(on)) {
    await s.click()
    await page.waitForTimeout(300)
  }
}

/** Off camera: pan the graph by dragging empty canvas. */
async function pan(page, dx, dy) {
  const all = Object.values(await nodes(page))
  const pane = await page.locator('.react-sigma').first().boundingBox()
  // A start point clear of every node, or the drag would move a node instead.
  let from
  for (const [x, y] of [
    [pane.x + 30, pane.y + 30],
    [pane.x + pane.width - 30, pane.y + 30],
    [pane.x + 30, pane.y + pane.height - 30]
  ])
    if (all.every((n) => Math.hypot(n.x - x, n.y - y) > 40)) from = { x, y }
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 40 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await page.waitForTimeout(600)
}

/** On camera: glide onto a node that may still be drifting (the layout reheats after an edit). */
async function onto(rec, page, label, ms = 500) {
  let n = await pos(page, label)
  await rec.glide(n.x, n.y, ms)
  n = await pos(page, label)
  await rec.glide(n.x, n.y, 120)
  return n
}

let target

export async function setup({ page }) {
  await page.getByTestId('rail-graph').click()
  await page.waitForTimeout(1500)
  await closeOtherTabs(page, 'Graph')
  if (await page.getByRole('tablist', { name: 'Right sidebar' }).count()) {
    await page.keyboard.press('Meta+Shift+B')
    await page.waitForTimeout(600)
  }
  await page.getByRole('button', { name: 'Toggle Sidebar' }).last().click()
  await page.waitForTimeout(600)
  // Notes only, with their labels: the arrangement the clip saves as a view at the end.
  await page.locator('[title="Graph settings"]').click()
  await page.waitForTimeout(600)
  for (const [row, on] of [
    ['Journals', false],
    ['Tasks', false],
    ['Projects', false],
    ['Show labels', true]
  ])
    await setSwitch(page, row, on)
  await page.locator('[title="Hide settings"]').click()
  await page.waitForTimeout(800)
  await settle(page)

  // One wheel step (sigma zooms 1.7x per step) around the notes, so every label has room.
  let all = Object.values(await nodes(page))
  const bx = [Math.min(...all.map((n) => n.x)), Math.max(...all.map((n) => n.x))]
  const by = [Math.min(...all.map((n) => n.y)), Math.max(...all.map((n) => n.y))]
  if ((bx[1] - bx[0]) * 1.7 < 1450 && (by[1] - by[0]) * 1.7 < 820) {
    await page.mouse.move((bx[0] + bx[1]) / 2, (by[0] + by[1]) / 2)
    await page.mouse.wheel(0, -100)
    await page.waitForTimeout(900)
  }

  // The trip note to link Ana to: the first one a clear drag away from her.
  const now = await nodes(page)
  const a = now[SOURCE]
  const d = (t) => Math.hypot(now[t].x - a.x, now[t].y - a.y)
  const options = TARGETS.filter((t) => now[t])
  target =
    options.find((t) => d(t) >= 200 && d(t) <= 520) ??
    options.sort((p, q) => Math.abs(d(p) - 320) - Math.abs(d(q) - 320))[0]
  // Ana and the target in the upper middle of the pane, clear of the caption band.
  const b = now[target]
  await pan(page, 780 - (a.x + b.x) / 2, 400 - (a.y + b.y) / 2)
  await settle(page, 3000)
  console.log(`  link ${SOURCE} -> ${target} (${Math.round(d(target))} px)`)
  all = await nodes(page)
  await page.mouse.move(all[SOURCE].x - 260, all[SOURCE].y - 170)
  await page.waitForTimeout(500)
}

export const scenes = {
  async hook({ rec, page, at }) {
    const a = await pos(page, SOURCE)
    await at(0.6)
    await rec.glide(a.x - 110, a.y - 70, 1300)
    await at(2.5)
    await rec.glide(a.x - 30, a.y - 20, 600)
  },
  async link({ rec, page, zoom, sleep, at }) {
    const a = await pos(page, SOURCE)
    const b = await pos(page, target)
    const z = Math.max(
      1.5,
      Math.min(1.9, 1600 / (Math.abs(a.x - b.x) + 360), 738 / (Math.abs(a.y - b.y) + 200))
    )
    zoom((a.x + b.x) / 2, (a.y + b.y) / 2 + 81 / z, z)
    await sleep(500)
    await onto(rec, page, SOURCE, 450)
    await sleep(300)
    await page.keyboard.down('Alt')
    rec.mark('click')
    await page.mouse.down()
    await sleep(200)
    await rec.glide((a.x + b.x) / 2, (a.y + b.y) / 2 - 40, 700)
    await onto(rec, page, target, 600)
    await sleep(300)
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await sleep(500)
    // Back onto Ana: her edges light up, the new one to the trip note among them.
    await onto(rec, page, SOURCE, 700)
    await at(5.9)
  },
  async tag({ rec, page, zoom, sleep, at }) {
    let a = await pos(page, SOURCE)
    zoom(a.x + 110, a.y + 120, 1.8)
    await sleep(400)
    a = await onto(rec, page, SOURCE, 300)
    rec.mark('click')
    await page.mouse.click(a.x, a.y, { button: 'right' })
    await sleep(450)
    await rec.click(page.getByRole('button', { name: 'Add tag…' }))
    await page.getByPlaceholder('Search or create a tag…').waitFor()
    await sleep(250)
    await rec.type('lisbon', { cps: 11 })
    await sleep(300)
    await rec.key('Enter')
    await sleep(500)
    // Her tooltip now lists the tag.
    a = await pos(page, SOURCE)
    await rec.glide(a.x + 40, a.y - 40, 300)
    await onto(rec, page, SOURCE, 350)
    await at(5.6)
  },
  async pin({ rec, page, zoom, sleep, at }) {
    // A free spot next to her: the one farthest from every other note, inside the pane.
    const all = await nodes(page)
    const a = all[SOURCE]
    const others = Object.entries(all)
      .filter(([k]) => k !== SOURCE)
      .map(([, n]) => n)
    let to
    let best = -1
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * 2 * Math.PI
      const p = { x: a.x + Math.cos(ang) * 170, y: a.y + Math.sin(ang) * 130 }
      if (p.x < 200 || p.x > 1350 || p.y < 120 || p.y > 640) continue
      const clear = Math.min(...others.map((n) => Math.hypot(n.x - p.x, n.y - p.y)))
      if (clear > best) [best, to] = [clear, p]
    }
    zoom((a.x + to.x) / 2 + 40, (a.y + to.y) / 2 + 60, 1.8)
    await sleep(300)
    await onto(rec, page, SOURCE, 300)
    await sleep(200)
    rec.mark('click')
    await page.mouse.down()
    await sleep(150)
    await rec.glide(to.x, to.y, 1000)
    await sleep(200)
    await page.mouse.up()
    await sleep(250)
    // Off the node, so the graph is not dimmed around it and the pin ring shows.
    await rec.glide(to.x + 90, to.y + 60, 500)
    zoom(to.x + 60, to.y + 50, 2.0)
    await at(4.4)
  },
  async save({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(400)
    await rec.click(page.locator('[title="Graph settings"]'))
    await sleep(400)
    zoom(1350, 190, 1.7)
    await rec.click(page.getByTestId('graph-views-trigger'))
    await sleep(400)
    await rec.click(page.getByTestId('graph-views-save-as'))
    const name = page.getByTestId('graph-views-save-name')
    await name.waitFor()
    await zoomOnDialog(zoom, name)
    await sleep(350)
    await rec.type('Notes only', { cps: 12 })
    await sleep(300)
    await rec.key('Enter')
    await sleep(250)
    zoom(1350, 190, 1.7)
    const c = await rec.center(page.getByTestId('graph-views-trigger'))
    await rec.glide(c.x - 30, c.y + 40, 600)
    await at(6.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

async function zoomOnDialog(zoom, field) {
  const b = await field.boundingBox()
  zoom(b.x + b.width / 2, b.y + 60, 1.7)
}

export const checks = [
  [
    'the view is saved',
    (q) =>
      (q("SELECT value FROM settings WHERE key = 'graphViews'")[0]?.value ?? '').includes(
        '"name":"Notes only"'
      )
        ? null
        : 'no "Notes only" view'
  ],
  [
    'the lisbon tag exists',
    (q) =>
      q("SELECT name FROM tag_definitions WHERE name = 'lisbon'").length ? null : 'no lisbon tag'
  ]
]
