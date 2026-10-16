// Tasks & Projects: what happens on screen in each scene of narration.json.
// ctx: page, rec (glide/click/type/key/center/mark), L, at(phrase, offset), end(), zoom, zoomOn,
// unzoom, caret, sleep. Coordinates are CSS px in the 1600x900 window.

/** Start state: Tasks, all projects, list view, day panel closed, sidebar projects open. */
export async function setup({ page, L, sleep }) {
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Tasks', exact: true }).first().click()
  await sleep(900)
  if (await L('[aria-label="Resize Day Panel"]').count())
    await L('[aria-label="Day Panel"]').click()
  const projects = page.getByRole('button', { name: /Projects section/i }).first()
  if ((await projects.getAttribute('aria-expanded')) !== 'true') await projects.click()
  await sleep(600)
}

/** A task row's status button: it opens To Do / In Progress / Done. */
const statusOf = (page, title) =>
  page
    .getByText(title, { exact: true })
    .first()
    .locator('xpath=ancestor::*[.//button[starts-with(@aria-label, "Status:")]][1]')
    .getByRole('button', { name: /^Status:/ })

export const scenes = {
  async intro({ rec }) {
    // The title card covers this scene; park the cursor where the capture scene starts.
    await rec.glide(700, 140, 600)
  },

  async capture({ page, rec, at, zoom, sleep }) {
    await at('Click the capture bar', -0.6)
    await rec.click(page.getByPlaceholder(/Add a task/).first(), { dx: -250 })
    // The words and chips run from x 567 to about 960; the date chip sits at the bar's right end.
    zoom(765, 57, 2.2)
    await at('type it')
    await rec.type('Draft the homepage copy')
    await at('An at sign', 0.3)
    await rec.type(' @fri')
    await at('Tab accepts', 0.1)
    await rec.key('Tab')
    await at('An exclamation', 0.3)
    await rec.type(' !h')
    await sleep(250)
    await rec.key('Tab')
    await at('a plus', 0.2)
    await rec.type(' +webs')
    await sleep(300)
    await rec.key('Tab')
    await at('a hash', 0.2)
    await rec.type(' #cli')
    await sleep(300)
    await rec.key('Tab')
    // The whole bar, so the parsed date shows in its chip at the right end.
    await at('Each one turns', 0.2)
    zoom(1000, 57, 1.75)
    await at('press enter', 0.1)
    await rec.key('Enter')
    // The new row in full: priority and title at its start, project and date at its far end.
    await sleep(400)
    const made = page.getByText('Draft the homepage copy', { exact: true }).first()
    await made.scrollIntoViewIfNeeded()
    const row = await made.boundingBox()
    zoom(960, row.y + row.height / 2, 1.3)
    await rec.glide(row.x + 80, row.y + row.height / 2, 700)
  },

  async repeat({ page, rec, at, zoom, zoomOn, unzoom, sleep }) {
    // The capture bar kept its focus; bring the cursor back up to it before the typing starts.
    await rec.glide(640, 57, 700)
    await at('Just write', -0.3)
    zoom(720, 57, 2.2)
    await rec.type('Water the plants every 2 weeks', { cps: 16 })
    await at('every two weeks', 0.6)
    await rec.key('Enter')
    await at("like this month's rent", -0.9)
    const rent = statusOf(page, 'Pay rent')
    const r = await rec.center(rent)
    zoom(700, r.y + 40, 1.8)
    await rec.click(rent)
    await sleep(400)
    await at('the next one', -0.5)
    const done = page.locator('[data-radix-popper-content-wrapper]').last()
    await rec.click(done.getByText('Done', { exact: true }))
    await sleep(500)
    await zoomOn(page.locator('[data-sonner-toast]').last(), 2.2)
    // The toast leaves after about 4 s, so pull back to the list before it goes.
    await at('Use a repeat', -0.2)
    unzoom()
  },

  async views({ page, rec, at, zoom, zoomOn, sleep }) {
    await at('Your list answers', -0.3)
    zoom(560, 300, 2)
    // Point at the group headers without clicking: a click collapses the group.
    const header = (name) => page.locator('main').getByText(name, { exact: true }).first()
    const pointAt = async (name) => {
      const h = await rec.center(header(name))
      await rec.glide(h.x + 40, h.y, 500)
    }
    await at('overdue first')
    await pointAt('Overdue')
    await at('then today')
    await pointAt('Today')
    await at('tomorrow')
    await pointAt('Tomorrow')
    await at('the rest of the week')
    await pointAt('This Week')
    await at('The views up here', -0.6)
    const views = page.getByRole('combobox', { name: 'Task views' })
    await rec.click(views)
    await sleep(250)
    zoom(500, 190, 2.2)
    await at('to today', 0.1)
    await rec.click(page.getByRole('option', { name: /^Today/ }).first())
    await at('Today keeps', 0.2)
    await zoomOn(header('Overdue'), 2.2, { dx: 230, dy: 60 })
  },

  async drawer({ page, rec, at, zoom, sleep }) {
    const pointAt = async (locator, ms) => {
      const c = await rec.center(locator)
      await rec.glide(c.x, c.y, ms)
    }
    await at('Click a task', -0.6)
    await rec.click(page.getByText('Finalize homepage hero', { exact: true }).first())
    await sleep(600)
    // The properties run down the drawer at x 1379: status, priority, Starts (y 199), Due (y 229),
    // repeat, reminder, project.
    const starts = page.getByText(/^Starts /).last()
    const due = page.getByText(/^Due /).last()
    zoom(1440, 214, 2.6)
    await at('start date')
    await pointAt(starts, 600)
    await at('due date')
    await pointAt(due, 400)
    await at('Break it', -0.4)
    zoom(1460, 560, 2.2)
    await rec.click(page.getByText('Add sub-issue', { exact: true }).first())
    await sleep(200)
    await rec.type('Get sign-off from Jonas', { cps: 17 })
    // Enter leaves an empty "Add sub-issue…" row open for the next one. Escape there closes the
    // whole drawer, so the row stays open, and after.drawer's Escape closes both.
    await rec.key('Enter')
    await at('keep the notes')
    zoom(1460, 690, 2.2)
    await pointAt(page.getByText('Website Redesign Brief', { exact: true }).last())
    // Back to the dates for when to use which.
    await at('A start date is', -0.3)
    zoom(1440, 229, 2.4)
    await pointAt(starts, 600)
    await at('A due date alone')
    await pointAt(due, 400)
  },

  async hub({ page, rec, at, zoom, sleep }) {
    await at('Open one', -0.6)
    await rec.click(page.getByText('Lisbon Trip', { exact: true }).first())
    await at('gathers', 0.2)
    zoom(800, 300, 1.6)
    await rec.glide(600, 200, 800)
    await at('and notes')
    zoom(600, 430, 2.2)
    await rec.glide(420, 440, 700)
    await at('The capture bar here', -0.6)
    await rec.click(page.getByPlaceholder(/Add to Lisbon Trip/).first(), { dx: -300 })
    zoom(700, 57, 2.2)
    await at('A task you type')
    await rec.type('Buy a SIM card', { cps: 16 })
    await rec.key('Enter')
    await at('a link you paste', 0.3)
    zoom(760, 260, 1.6)
    rec.mark('paste')
    await page.keyboard.insertText('https://www.visitlisboa.com/en')
    await sleep(500)
    await rec.key('Enter')
  },

  async kanban({ page, rec, at, zoom, unzoom, sleep }) {
    // after.hub already went back to Tasks, so the board switch lands on its words.
    await rec.click(page.getByRole('combobox', { name: 'Select project' }))
    await sleep(400)
    await rec.click(page.getByRole('option', { name: /Website Redesign/ }).first())
    await at('Switch the project', -0.6)
    await rec.click(page.locator('[aria-label="Kanban view"]'))
    await sleep(500)
    await at('drag a card', -0.9)
    const c = await rec.center(page.getByText('Build style guide page', { exact: true }).first())
    const d = await rec.center(page.getByText('Mobile navigation', { exact: true }).first())
    // Backlog and Design side by side, so the card stays in frame the whole way.
    zoom((c.x + d.x) / 2, 260, 1.8)
    await rec.glide(c.x, c.y)
    rec.mark('drag-start')
    await page.mouse.down()
    await sleep(120)
    await rec.glide(c.x + 12, c.y + 6, 120)
    await rec.glide(d.x, d.y + 60, 900)
    await sleep(250)
    await page.mouse.up()
    rec.mark('drag-end')
    // The project's settings open from the gear on its sidebar row, at x 274.
    await at('Rename one', -1.4)
    const row = await rec.center(page.getByText('Website Redesign', { exact: true }).first())
    await rec.glide(row.x, row.y, 600)
    await sleep(250)
    await rec.glide(274, row.y, 300)
    rec.mark('click')
    await page.mouse.down()
    await page.mouse.up()
    await sleep(700)
    const dialog = page.getByRole('dialog')
    const review = dialog.getByPlaceholder('Status name').nth(2)
    const rv = await rec.center(review)
    zoom(800, rv.y, 2)
    await rec.click(review)
    await rec.key('ControlOrMeta+a')
    await rec.type('Client review', { cps: 15 })
    const save = dialog.getByRole('button', { name: 'Save', exact: true })
    await save.scrollIntoViewIfNeeded()
    await sleep(300)
    await at('the board follows', -0.8)
    await rec.click(save)
    await sleep(500)
    zoom(1000, 250, 2)
    await at('and the list', -0.4)
    unzoom()
    await rec.click(page.locator('[aria-label="List view"]'))
  },

  async notes({ page, rec, at, zoom, caret, sleep }) {
    await rec.click(page.getByRole('button', { name: 'Search or jump to…' }))
    await sleep(300)
    await rec.type('brief', { cps: 12 })
    await sleep(500)
    // Enter opens whichever note ranks first (a note linking the brief once did), so pick it by title.
    await rec.click(page.getByRole('option', { name: /^Website Redesign Brief/ }).first())
    await sleep(1100)
    const lb = await page
      .getByText('Jonas (founder), Lea (marketing)', { exact: true })
      .boundingBox()
    await at('start a line', -0.9)
    await rec.glide(lb.x + lb.width + 4, lb.y + lb.height / 2)
    rec.mark('click')
    await page.mouse.down()
    await page.mouse.up()
    await sleep(150)
    await rec.key('End')
    await rec.key('Enter')
    await rec.type('[ ] ', { cps: 10 })
    await sleep(250)
    // The editor scrolls on Enter, so aim at the caret, not at where the line was. The row runs
    // about 640 px from the text column's start, chips at its end: center on the whole row.
    const c = await caret()
    zoom(lb.x + 320, c.y, 1.6)
    await at('write the task', -0.2)
    await rec.type('Send the style guide to Lea @tomorrow !h', { cps: 17 })
    await sleep(300)
    // Escape leaves the title: the markers become chips, and no empty task row opens below.
    await at('It becomes', -0.3)
    await rec.key('Escape')
    await at('shows up in Tasks', -0.9)
    await rec.click(page.getByRole('button', { name: 'Tasks', exact: true }).first())
    await sleep(600)
    const task = await rec.center(
      page.getByText('Send the style guide to Lea', { exact: true }).first()
    )
    zoom(960, task.y, 1.4)
    await rec.glide(task.x, task.y, 600)
  },

  async outro({ rec }) {
    await rec.glide(800, 450, 1500)
  }
}

/** Runs after a scene's narration has ended, before the next scene starts. */
export const after = {
  async views({ page, rec, unzoom, sleep }) {
    unzoom()
    const views = page.getByRole('combobox', { name: 'Task views' })
    await rec.click(views)
    await sleep(350)
    await rec.click(page.getByRole('option', { name: /^All/ }).first())
    await sleep(500)
  },
  async drawer({ rec, unzoom, sleep }) {
    unzoom()
    await rec.key('Escape')
    await sleep(250)
    await rec.key('Escape')
    await sleep(400)
  },
  async hub({ page, rec, unzoom, sleep }) {
    // The link note needs a moment to fetch its title and appear under Notes.
    await sleep(1500)
    unzoom()
    await rec.click(page.getByRole('button', { name: 'Tasks', exact: true }).first())
    await sleep(500)
  },
  async notes({ unzoom }) {
    unzoom()
  }
}

/** What the recording must have written. Each check returns an error string or nothing. */
export const checks = [
  [
    'Quick capture parsed every marker',
    (q) => {
      const [t] = q(`SELECT t.due_date, t.priority, p.name AS project,
      (SELECT group_concat(tag) FROM task_tags WHERE task_id = t.id) AS tags
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title = 'Draft the homepage copy'`)
      if (!t) return 'task "Draft the homepage copy" missing (title kept a marker?)'
      if (
        t.project !== 'Website Redesign' ||
        t.priority !== 3 ||
        t.tags !== 'client' ||
        !t.due_date
      )
        return JSON.stringify(t)
    }
  ],
  [
    'Repeat became a cadence',
    (q) => {
      const [t] = q(`SELECT repeat_config FROM tasks WHERE title = 'Water the plants'`)
      if (!t?.repeat_config?.includes('"interval":2')) return JSON.stringify(t)
    }
  ],
  [
    'Finishing the rent created the next one',
    (q) => {
      const rows = q(
        `SELECT due_date, completed_at IS NOT NULL AS done FROM tasks WHERE title = 'Pay rent' ORDER BY due_date`
      )
      if (rows.length !== 2 || !rows[0].done || rows[1].done) return JSON.stringify(rows)
    }
  ],
  [
    'Sub-issue under the hero task',
    (q) => {
      const [t] = q(
        `SELECT p.title FROM tasks c JOIN tasks p ON p.id = c.parent_id WHERE c.title = 'Get sign-off from Jonas'`
      )
      if (t?.title !== 'Finalize homepage hero') return JSON.stringify(t)
    }
  ],
  [
    'Hub capture filed in Lisbon Trip',
    (q) => {
      const [t] = q(
        `SELECT p.name FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title = 'Buy a SIM card'`
      )
      if (t?.name !== 'Lisbon Trip') return JSON.stringify(t)
    }
  ],
  [
    'Card moved to Design',
    (q) => {
      const [t] = q(
        `SELECT s.name FROM tasks t JOIN statuses s ON s.id = t.status_id WHERE t.title = 'Build style guide page'`
      )
      if (t?.name !== 'Design') return JSON.stringify(t)
    }
  ],
  [
    'Review column renamed',
    (q) => {
      const names = q(
        `SELECT s.name FROM statuses s JOIN projects p ON p.id = s.project_id WHERE p.name = 'Website Redesign' ORDER BY s.position`
      ).map((s) => s.name)
      if (names.join() !== 'Backlog,Design,Client review,Done') return JSON.stringify(names)
    }
  ],
  [
    'Checkbox in the note became a task',
    (q) => {
      const [t] = q(
        `SELECT priority, due_date FROM tasks WHERE title = 'Send the style guide to Lea'`
      )
      if (!t || t.priority !== 3 || !t.due_date) return JSON.stringify(t)
    }
  ]
]
