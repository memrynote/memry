// Runs a film's scenes against a stand-in page that answers every call of the WebDriver page's
// subset at once and throws NotInSubset for any other, so `clip.mjs <slug> --check` finds the
// calls a scene makes outside the subset without an app, a vault or a recording. It also reports
// literal coordinates outside the film and scenes that still drive Electron's main process.
import * as fs from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { FILM } from './screen-rec.mjs'
import { NotInSubset, SUBSET, guard } from './wd-page.mjs'

const NOOP = () => undefined
const ASYNC_NOOP = async () => undefined
function callable() {
  return undefined
}

/** A value that survives any use a scene makes of an evaluate() result: reads, math, loops. */
function anything() {
  const proxy = new Proxy(callable, {
    get(_, prop) {
      if (prop === 'then') return undefined
      // Mid-film, so a coordinate read from the page stays inside it.
      if (prop === Symbol.toPrimitive) return () => 400
      if (prop === Symbol.iterator) return () => [][Symbol.iterator]()
      if (typeof prop === 'symbol') return undefined
      return proxy
    },
    apply: () => proxy
  })
  return proxy
}

// Upper left of the film, so the offsets scenes add to a box (up to about -250 and +600 px) stay
// inside: what lands outside is a literal coordinate of the old 1600x900 window.
const BOX = { x: 400, y: 200, width: 200, height: 40 }

/** The stand-in of a locator: the queries chain, the reads answer, the actions resolve. */
function stubLocator() {
  const target = { spec: { steps: [] }, core: null }
  for (const name of SUBSET.locator) target[name] = async () => undefined
  for (const name of [
    'locator',
    'getByRole',
    'getByText',
    'getByTestId',
    'getByPlaceholder',
    'getByLabel',
    'first',
    'last',
    'nth',
    'filter'
  ]) {
    target[name] = () => stubLocator()
  }
  target.boundingBox = async () => ({ ...BOX })
  target.count = async () => 1
  target.isVisible = async () => true
  target.textContent = async () => ''
  return target
}

function stubPage(onPoint) {
  const page = {}
  for (const name of SUBSET.page) page[name] = async () => anything()
  for (const name of [
    'locator',
    'getByRole',
    'getByText',
    'getByTestId',
    'getByPlaceholder',
    'getByLabel'
  ]) {
    page[name] = () => stubLocator()
  }
  page.screenshot = async () => Buffer.alloc(0)
  page.keyboard = Object.fromEntries(SUBSET.keyboard.map((name) => [name, async () => undefined]))
  page.mouse = Object.fromEntries(SUBSET.mouse.map((name) => [name, async () => undefined]))
  page.mouse.move = async (x, y) => onPoint('page.mouse.move', x, y)
  page.mouse.click = async (x, y) => onPoint('page.mouse.click', x, y)
  return guard(page, SUBSET.page, 'page')
}

const ELECTRON_MAIN = /process\.mainModule|apps\/desktop\/scripts\/agent-app\.mjs/

/**
 * @returns {Promise<{ notInSubset: string[], outside: string[], errors: string[], electronMain: boolean }>}
 */
export async function dryRun(dir, film = FILM) {
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  const source = fs.readFileSync(path.join(dir, 'scenes.mjs'), 'utf8')
  const report = {
    notInSubset: [],
    outside: [],
    errors: [],
    electronMain: ELECTRON_MAIN.test(source)
  }
  let scene = 'setup'
  const onPoint = (what, x, y) => {
    if (typeof x === 'number' && (x < 0 || x > film.width || y < 0 || y > film.height)) {
      report.outside.push(`${scene}: ${what}(${Math.round(x)}, ${Math.round(y)})`)
    }
  }
  const page = stubPage(onPoint)
  const rec = {
    mouse: { x: 630, y: 405 },
    speed: NOOP,
    speedEnd: NOOP,
    mark: NOOP,
    now: () => 0,
    remap: (t) => t,
    async glide(x, y) {
      onPoint('rec.glide', x, y)
      this.mouse = { x, y }
    },
    async center(locator) {
      const b = await locator.boundingBox()
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    },
    async click(locator, { dx = 0, dy = 0 } = {}) {
      const c = await this.center(locator)
      await this.glide(c.x + dx, c.y + dy)
    },
    type: ASYNC_NOOP,
    async key(k) {
      await page.keyboard.press(k)
    }
  }
  const ctx = {
    page,
    rec,
    sleep: ASYNC_NOOP,
    L: (s) => page.locator(s),
    at: ASYNC_NOOP,
    end: ASYNC_NOOP,
    zoom: (x, y) => onPoint('zoom', x, y),
    unzoom: NOOP,
    async zoomOn(locator, z, { dx = 0, dy = 0 } = {}) {
      const c = await rec.center(locator)
      onPoint('zoomOn', c.x + dx, c.y + dy)
    },
    caret: async () => ({ x: BOX.x, y: BOX.y })
  }
  const run = async (fn) => {
    try {
      await fn?.(ctx)
    } catch (error) {
      if (error instanceof NotInSubset) report.notInSubset.push(`${scene}: ${error.call}`)
      else report.errors.push(`${scene}: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
  // Scenes that read agent-app's state or write scratch files do so under an empty temp dir.
  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = mkdtempSync(path.join(tmpdir(), 'memry-film-check-'))
  try {
    const mod = await import(pathToFileURL(path.join(dir, 'scenes.mjs')).href)
    await run(mod.setup)
    for (const s of N.scenes) {
      scene = s.id
      if (!mod.scenes?.[s.id]) report.errors.push(`${s.id}: scenes.mjs has no scene`)
      else await run(mod.scenes[s.id])
      await run(mod.after?.[s.id])
    }
  } finally {
    fs.rmSync(process.env.TMPDIR, { recursive: true, force: true })
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
  }
  return report
}
