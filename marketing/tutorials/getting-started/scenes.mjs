// Getting started: what happens on screen in each scene of narration.json.
// ctx: page, rec (glide/click/type/key/center/mark), L, at(phrase, offset), end(), zoom, zoomOn,
// unzoom, caret, sleep. Coordinates are CSS px in the 1600x900 window.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCursor } from '../engine/rec.mjs'

const NOTE = 'Workshop plan'
const TASK = 'Send Jonas the workshop agenda'
const CAPTURE = 'Ask Lea for the photo credits'
const LINK = 'https://www.visitlisboa.com/en'
const JOURNAL_LINE = 'Workshop agenda is done. Sending it to Jonas tomorrow.'
const JOURNAL_TASK = 'Review the moodboard with Lea'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets')

const NOTE_ICONS = {
  'Website Redesign Brief': '📋',
  'Studio North Kickoff': '🤝',
  'Homepage Ideas': '💡',
  'Design Principles': '🧭',
  'Lisbon Itinerary': '🗺️',
  'Lisbon Ideas': '✨',
  'Lisbon Packing List': '🧳',
  'Reading List': '📚'
}
const BOOKMARKED = ['Website Redesign Brief', 'Design Principles', 'Lisbon Itinerary']
const HOME_WIDGETS = [
  ['recently-edited', 0, 0],
  ['tasks', 4, 0],
  ['journal', 0, 4],
  ['calendar', 4, 4],
  ['bookmarks', 0, 8],
  ['inbox', 4, 8]
]

/**
 * Start state: a lived-in vault. The seed holds the data the CLI can write; icons, bookmarks, a
 * canvas and the Home board go through the app's own API, as a user's clicks would. Ends on Home,
 * day panel closed, every sidebar section open.
 */
export async function setup({ page, L, sleep }) {
  await page.keyboard.press('Escape')
  await page.evaluate(
    async ({ icons, bookmarked, widgets }) => {
      const list = await window.api.notes.list({ limit: 200 })
      const notes = list.notes ?? list
      for (const n of notes)
        if (icons[n.title]) await window.api.notes.update({ id: n.id, emoji: icons[n.title] })
      for (const title of bookmarked) {
        const n = notes.find((x) => x.title === title)
        if (n) await window.api.bookmarks.create({ itemType: 'note', itemId: n.id })
      }
      await window.api.canvas.create({ title: 'Studio North moodboard' })
      const [home] = await window.api.homePages.list()
      await window.api.homePages.update({
        id: home.id,
        widgets: widgets.map(([type, x, y], i) => ({
          id: `w${i}`,
          type,
          x,
          y,
          w: 4,
          h: 4,
          config: type === 'tasks' ? { dateRange: 'today' } : {}
        }))
      })
    },
    { icons: NOTE_ICONS, bookmarked: BOOKMARKED, widgets: HOME_WIDGETS }
  )
  // Let the API writes settle: a reload in flight made the app die twice.
  await sleep(1500)
  await page.reload()
  await sleep(2500)
  // The reload drops the film's cursor, which record() installed before setup() ran.
  await installCursor(page)
  await page.getByRole('button', { name: 'Home', exact: true }).first().click()
  if (await L('[aria-label="Resize Day Panel"]').count())
    await L('[aria-label="Day Panel"]').click()
  for (const name of [
    /^Collections section/,
    /^Projects section/,
    /^Bookmarks section/,
    /^Canvases section/,
    /^Tags section/
  ]) {
    const h = page.getByRole('button', { name }).first()
    if (!(await h.count())) continue
    if ((await h.getAttribute('aria-expanded')) !== 'true') await h.click()
  }
  await sleep(1200)
}

const rail = (page, name) => page.getByRole('button', { name, exact: true }).first()

export const scenes = {
  async intro({ rec }) {
    // The title card covers this scene; park the cursor where the vault scene starts.
    await rec.glide(160, 100, 600)
  },

  async vault({ page, rec, at, zoom, sleep }) {
    await at('The name sits up here', -0.4)
    zoom(170, 110, 2.4)
    await rec.click(page.getByRole('button', { name: /Open the vault list/ }))
    await sleep(400)
    await at('this list shows', 0.1)
    await at('Open vault', -0.3)
    await rec.glide(200, 190, 600)
  },

  async sync({ page, rec, at, zoom, sleep }) {
    await at('This icon says so', -1.2)
    zoom(50, 810, 2.4)
    await rec.click(page.getByRole('button', { name: 'Sync disabled' }))
    await sleep(700)
    await at('you set it up here', -0.2)
    zoom(800, 330, 1.8)
    await at('Sync needs a paid plan')
    zoom(800, 480, 2.2)
    await at('recovery phrase', 0.3)
    zoom(800, 330, 1.8)
  },

  async tour({ page, rec, at, zoom, sleep }) {
    await at('This is the rail', -0.3)
    zoom(200, 240, 2)
    const names = ['Home', 'Inbox', 'Journal', 'Calendar', 'Tasks', 'Graph']
    const cues = ['From the top', 'Inbox', 'Journal', 'Calendar', 'Tasks', 'Graph']
    for (let i = 0; i < names.length; i++) {
      await at(i === 0 ? 'Home' : cues[i], -0.15)
      const c = await rec.center(rail(page, names[i]))
      await rec.glide(c.x, c.y, 350)
    }
    await at('Hold Command', 0.8)
    await at('Next to it is the sidebar', -0.2)
    zoom(190, 220, 1.7)
    const sections = [
      ['Collections holds', /^Collections section/],
      ['Projects lists', /^Projects section/],
      ['Bookmarks keeps', /^Bookmarks section/],
      ['Canvases holds', /^Canvases section/],
      ['Tags gathers', /^Tags section/]
    ]
    for (const [cue, name] of sections) {
      await at(cue, -0.2)
      const c = await rec.center(page.getByRole('button', { name }).first())
      zoom(190, c.y + 60, 2)
      await rec.glide(150, c.y + 40, 500)
    }
    await at('The pen button', -0.2)
    zoom(170, 97, 2.6)
    await rec.glide(108, 97, 500)
    await at('the arrow beside it', -0.3)
    await rec.click(page.getByRole('button', { name: 'Create new…' }))
    await sleep(500)
    zoom(240, 220, 2.2)
  },

  async note({ page, rec, at, zoom, caret, sleep }) {
    await at('click the pen', -0.6)
    zoom(300, 120, 1.6)
    await rec.click(page.getByRole('button', { name: /^New note/ }).first())
    await sleep(1100)
    await at('Give it a title', 0.2)
    zoom(800, 110, 2)
    await rec.type(NOTE, { cps: 13 })
    await rec.key('Enter')
    await sleep(300)
    await at('start writing', 0.1)
    await rec.click(page.locator('.bn-editor p').first())
    await rec.type('Friday workshop with Studio North.', { cps: 15 })
    await rec.key('Enter')
    await at('type a slash', -0.2)
    const c = await caret()
    zoom(760, c.y + 250, 1.4)
    await rec.type('/', { cps: 8 })
    await sleep(500)
    await at('so slash h two', 0.0)
    await rec.type('h2', { cps: 6 })
    await sleep(500)
    await at('a heading', 0.2)
    await rec.key('Enter')
    await rec.type('Agenda', { cps: 12 })
    await rec.key('Enter')
    await at('no save button')
    await rec.type('Intro, moodboard review, next steps.', { cps: 16 })
  },

  async link({ page, rec, at, zoom, caret, sleep }) {
    await rec.key('Enter')
    await at('Type two square brackets', -0.2)
    await rec.type('Ideas from ', { cps: 15 })
    const c = await caret()
    zoom(620, c.y + 120, 1.8)
    await rec.type('[[', { cps: 6 })
    await at('like Design', -0.2)
    await rec.type('Design', { cps: 8 })
    await sleep(700)
    await at('suggests the notes')
    await at('Press Enter', -0.1)
    await rec.key('Enter')
    await sleep(500)
    await at('Click it to jump', -0.3)
    await rec.click(page.locator('.bn-editor .wiki-link').first())
    await sleep(1000)
    await at('lists this one under its backlinks', -2.2)
    zoom(760, 700, 2)
  },

  async inbox({ page, rec, at, zoom, sleep }) {
    await at('Open it', -0.4)
    await rec.click(rail(page, 'Inbox'))
    await sleep(700)
    await at('type into the capture bar', -0.4)
    const input = page.getByPlaceholder(/Quick capture/).first()
    const box = await input.boundingBox()
    zoom(box.x + 330, box.y + 190, 1.5)
    await rec.click(input)
    await rec.type(CAPTURE, { cps: 14 })
    await at('press Enter', -0.1)
    await rec.key('Enter')
    await sleep(700)
    await at('Paste a link', 0.2)
    rec.mark('paste')
    await page.keyboard.insertText(LINK)
    await sleep(400)
    await rec.key('Enter')
    await at('Attach a file', -0.2)
    const attach = page.getByRole('button', { name: 'Attach file' })
    for (const [cue, file] of [
      ['a PDF here', 'Moodboard.pdf'],
      ['an image there', 'alfama.png']
    ]) {
      await at(cue, -0.5)
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), rec.click(attach)])
      await chooser.setFiles(path.join(ASSETS, file))
      await sleep(1200)
    }
    await at('Click any item', -0.3)
    await rec.click(page.getByText('Moodboard', { exact: true }).first())
    await sleep(900)
    zoom(1100, 330, 1.35)
    await at('pick a folder', -0.2)
    await at('or file it', 0.3)
    await at('Text, links', -0.2)
    zoom(700, 260, 1.3)
    await rec.glide(500, 330, 700)
    await at('file this PDF', -0.5)
    await rec.click(page.getByText(/File to Notes/).first())
    await sleep(1500)
  },

  async task({ page, rec, at, zoom, sleep }) {
    await at('Go to Tasks', -0.4)
    await rec.click(rail(page, 'Tasks'))
    await sleep(900)
    await at('click the capture bar', -0.4)
    await rec.click(page.getByPlaceholder(/Add a task/).first(), { dx: -250 })
    zoom(765, 57, 2.2)
    await at('type it the way', 0.0)
    await rec.type(TASK, { cps: 15 })
    await at('An at sign', 0.3)
    await rec.type(' @fri', { cps: 8 })
    await sleep(250)
    await rec.key('Tab')
    await at('an exclamation mark', 0.2)
    await rec.type(' !h', { cps: 8 })
    await sleep(250)
    await rec.key('Tab')
    await at('Each one turns', 0.1)
    zoom(1000, 57, 1.75)
    await at('Press Enter', -0.1)
    await rec.key('Enter')
    await sleep(500)
    const made = page.getByText(TASK, { exact: true }).first()
    await made.scrollIntoViewIfNeeded()
    const row = await made.boundingBox()
    zoom(960, row.y + row.height / 2, 1.3)
    await rec.glide(row.x + 80, row.y + row.height / 2, 700)
  },

  async journal({ page, rec, at, zoom, caret, sleep }) {
    await at('End the day', -0.4)
    await rec.click(rail(page, 'Journal'))
    await sleep(1200)
    await at('Maya already has a line', -0.3)
    zoom(800, 330, 1.6)
    await at('Click at the end', -0.3)
    const last = page.locator('.bn-editor p').last()
    const b = await last.boundingBox()
    await rec.glide(b.x + b.width + 6, b.y + b.height / 2, 700)
    rec.mark('click')
    await page.mouse.down()
    await page.mouse.up()
    await sleep(150)
    await rec.key('End')
    await rec.key('Enter')
    await at('write the next one', -0.2)
    const c = await caret()
    zoom(800, c.y, 1.8)
    await rec.type(JOURNAL_LINE, { cps: 16 })
    await at('Start a line with a checkbox', -0.2)
    await rec.key('Enter')
    await rec.type('[ ] ', { cps: 8 })
    await sleep(500)
    await at('and write the task', 0.2)
    await rec.type(`${JOURNAL_TASK} @today`, { cps: 16 })
    await sleep(300)
    await at('It turns into a real task', -0.2)
    await rec.key('Escape')
    await at('day panel on the right', -0.9)
    zoom(800, 330, 1.2)
    await page.locator('[aria-label="Day Panel"]').click()
    await sleep(900)
    zoom(1300, 560, 1.6)
    await at('Drag it onto', -0.6)
    const row = await page.getByText(JOURNAL_TASK, { exact: true }).last().boundingBox()
    const sx = row.x + 20
    const sy = row.y + row.height / 2
    await rec.glide(sx, sy, 700)
    rec.mark('drag-start')
    await page.mouse.down()
    await sleep(150)
    await rec.glide(sx + 12, sy - 6, 120)
    await rec.glide(1450, 560, 1000)
    await sleep(250)
    await page.mouse.up()
    rec.mark('drag-end')
    await sleep(800)
  },

  async search({ page: _page, rec, at, zoom, sleep }) {
    await at('Command K finds', -0.3)
    await rec.key('ControlOrMeta+k')
    await sleep(500)
    await at('Type a few letters', 0.0)
    zoom(800, 280, 1.6)
    await rec.type('lisbon', { cps: 8 })
    await sleep(600)
    await at('grouped by type', -0.6)
    zoom(800, 330, 1.9)
    await at('Search for terracotta', 0.2)
    await rec.key('ControlOrMeta+a')
    await rec.type('terracotta', { cps: 9 })
    await sleep(900)
  },

  async outro({ rec, unzoom }) {
    unzoom()
    await rec.key('Escape')
    await rec.glide(800, 450, 1500)
  }
}

/** Runs after a scene's narration has ended, before the next scene starts. */
export const after = {
  async vault({ rec, unzoom, sleep }) {
    unzoom()
    await rec.key('Escape')
    await sleep(300)
  },
  async sync({ page, rec, unzoom, sleep }) {
    unzoom()
    await rec.click(page.getByRole('button', { name: 'Back' }).first()).catch(() => {})
    await rec.key('Escape')
    await rec.click(rail(page, 'Home'))
    await sleep(600)
  },
  async tour({ rec, unzoom, sleep }) {
    unzoom()
    await rec.key('Escape')
    await sleep(400)
  },
  async note({ rec: _rec, sleep }) {
    await sleep(600)
  },
  async link({ unzoom }) {
    unzoom()
  },
  async task({ unzoom }) {
    unzoom()
  },
  async inbox({ unzoom }) {
    unzoom()
  },
  async journal({ page, rec: _rec, unzoom, sleep }) {
    unzoom()
    await sleep(600)
    await page.locator('[aria-label="Day Panel"]').click()
    await sleep(500)
  }
}

const vaultPath = () =>
  JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'memry-agent-app.json'), 'utf8')).vaultPath

const readAll = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory()
      ? e.name.startsWith('.')
        ? []
        : readAll(p)
      : e.name.endsWith('.md')
        ? [fs.readFileSync(p, 'utf8')]
        : []
  })

/** What the recording must have written. Each check returns an error string or nothing. */
export const checks = [
  [
    'First note holds a heading and a wiki link',
    (q) => {
      const [n] = q(`SELECT path FROM note_metadata WHERE title = '${NOTE}'`)
      if (!n) return `note "${NOTE}" missing`
      const body = fs.readFileSync(path.join(vaultPath(), n.path), 'utf8')
      if (!body.includes('[[Design Principles]]')) return `no link in: ${body}`
      if (!/^## Agenda/m.test(body)) return `no h2 in: ${body}`
      return undefined
    }
  ],
  [
    'Inbox captured the thought',
    (q) => {
      const [i] = q(`SELECT title FROM inbox_items WHERE title = '${CAPTURE}'`)
      if (!i) return 'capture missing'
      return undefined
    }
  ],
  [
    'Task parsed its date and priority',
    (q) => {
      const [t] = q(`SELECT due_date, priority FROM tasks WHERE title = '${TASK}'`)
      if (t?.priority !== 3 || !t.due_date) return JSON.stringify(t)
      return undefined
    }
  ],
  [
    'Journal task got a time on the calendar',
    (q) => {
      const [t] = q(`SELECT due_date, due_time FROM tasks WHERE title = '${JOURNAL_TASK}'`)
      if (!t?.due_time) return JSON.stringify(t)
      return undefined
    }
  ],
  [
    'PDF was filed into the vault',
    (q) => {
      const [f] = q(`SELECT path FROM note_metadata WHERE file_type = 'pdf'`)
      if (!f) return 'no PDF note'
      return undefined
    }
  ],
  [
    "Today's journal has the new line",
    () => {
      const all = readAll(path.join(vaultPath(), 'journal')).join('\n')
      if (!all.includes(JOURNAL_LINE)) return 'journal line missing'
      return undefined
    }
  ]
]
