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

export const scenes = {
  async intro({ rec }) {
    // The title card covers this scene; park the cursor where the capture scene starts.
    await rec.glide(760, 300, 600)
  },

  async capture({ page, rec, at, zoom, sleep }) {
    await at('capture bar', -0.3)
    await rec.click(page.getByPlaceholder(/Add a task/).first(), { dx: -250 })
    zoom(760, 60, 1.9)
    await at('Type what')
    await rec.type('Draft the homepage copy')
    await at('An at sign', 0.3)
    await rec.type(' @fri')
    await sleep(250)
    await rec.key('Tab')
    await at('an exclamation', 0.3)
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
    await at('press enter', 0.1)
    await rec.key('Enter')
  },

  async repeat({ rec, at }) {
    await at('Just write')
    await rec.type('Water the plants every 2 weeks', { cps: 16 })
    await at('every two weeks', 0.6)
    await rec.key('Enter')
  },

  async views({ page, rec, at, zoomOn, sleep }) {
    await rec.glide(420, 140, 900)
    await at('Overdue')
    await rec.glide(470, 128, 500)
    await at('then today')
    await rec.glide(470, 300, 700)
    await at('And the views')
    const views = page.getByRole('combobox', { name: 'Task views' })
    await rec.click(views)
    await sleep(300)
    await zoomOn(views, 1.6)
    await at('just today', 0.2)
    await rec.click(page.getByRole('option', { name: /^Today/ }).first())
    await at('or the next', 0.1)
    await rec.click(views)
    await sleep(450)
    await rec.click(page.getByRole('option', { name: /^Next 7 days/ }).first())
  },

  async drawer({ page, rec, at, zoom, sleep }) {
    await rec.click(page.getByText('Finalize homepage hero', { exact: true }).first())
    await sleep(700)
    zoom(1300, 330, 1.45)
    await at('start date')
    await rec.glide(1210, 245, 700)
    await at('Break bigger')
    await rec.click(page.getByText('Add sub-issue', { exact: true }).first())
    await sleep(200)
    await rec.type('Get sign-off from Jonas', { cps: 17 })
    await rec.key('Enter')
    await sleep(250)
    await rec.key('Escape')
    await at('keep the notes')
    const related = await rec.center(
      page.getByText('Website Redesign Brief', { exact: true }).last()
    )
    await rec.glide(related.x, related.y)
  },

  async hub({ page, rec, at }) {
    await at('Open one', -0.6)
    await rec.click(page.getByText('Lisbon Trip', { exact: true }).first())
    await at('gathers', 0.2)
    await rec.glide(560, 300, 900)
    await at('notes')
    await rec.glide(560, 760, 1000)
  },

  async hubcapture({ page, rec, at, zoom, sleep }) {
    await rec.click(page.getByPlaceholder(/Add to Lisbon Trip/).first(), { dx: -250 })
    zoom(700, 230, 1.5)
    await at('A task you type')
    await rec.type('Buy a SIM card', { cps: 16 })
    await rec.key('Enter')
    await at('a link you paste', 0.3)
    rec.mark('paste')
    await page.keyboard.insertText('https://www.visitlisboa.com/en')
    await sleep(500)
    await rec.key('Enter')
  },

  async kanban({ page, rec, at, L, sleep }) {
    // after.hubcapture already went back to Tasks, so the board switch lands on its words.
    await rec.click(page.getByRole('combobox', { name: 'Select project' }))
    await sleep(400)
    await rec.click(page.getByRole('option', { name: /Website Redesign/ }).first())
    await at('Switch to the board', -0.6)
    await rec.click(L('[aria-label="Kanban view"]'))
    await sleep(500)
    await at('drag a card', -0.9)
    const c = await rec.center(page.getByText('Build style guide page', { exact: true }).first())
    const d = await rec.center(page.getByText('Mobile navigation', { exact: true }).first())
    await rec.glide(c.x, c.y)
    rec.mark('drag-start')
    await page.mouse.down()
    await sleep(120)
    await rec.glide(c.x + 12, c.y + 6, 120)
    await rec.glide(d.x, d.y + 60, 900)
    await sleep(250)
    await page.mouse.up()
    rec.mark('drag-end')
    await at('The columns')
    await rec.glide(d.x - 60, 105, 800)
  },

  async notes({ page, rec, at, zoom, caret, sleep }) {
    await rec.click(page.getByRole('button', { name: 'Search or jump to…' }))
    await sleep(300)
    await rec.type('brief', { cps: 12 })
    await sleep(400)
    await rec.key('Enter')
    await sleep(1100)
    const lb = await page
      .getByText('Jonas (founder), Lea (marketing)', { exact: true })
      .boundingBox()
    await at('Type a checkbox', -0.9)
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
    await rec.type('Send the style guide to Lea @tomorrow !h', { cps: 17 })
    await sleep(300)
    // Escape leaves the title: the markers become chips, and no empty task row opens below.
    await at('with its date', -0.3)
    await rec.key('Escape')
  },

  async outro({ page, rec, sleep }) {
    await rec.click(page.getByRole('button', { name: 'Tasks', exact: true }).first())
    await sleep(400)
    await rec.glide(800, 450, 1500)
  }
}

/** Runs after a scene's narration has ended, before the next scene starts. */
export const after = {
  async repeat({ rec, unzoom }) {
    await rec.key('Escape')
    unzoom()
  },
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
  async hubcapture({ page, rec, unzoom, sleep }) {
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
    'Checkbox in the note became a task',
    (q) => {
      const [t] = q(
        `SELECT priority, due_date FROM tasks WHERE title = 'Send the style guide to Lea'`
      )
      if (!t || t.priority !== 3 || !t.due_date) return JSON.stringify(t)
    }
  ]
]
