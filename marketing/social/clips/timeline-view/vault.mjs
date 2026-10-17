// Bars for the Timeline: Maya's planned work gets start dates, so those tasks span days instead of
// sitting on their due date, and a two-day client visit joins the Lisbon trip as an event. The
// loose Inbox tasks are filed into her projects, so the chart opens on the events and the
// Website Redesign cascade, and the drag (a task that clashes with the trip) stays in frame.
export default function ({ cli, day, TIMEZONE }) {
  const byTitle = Object.fromEntries(
    cli('tasks', 'list', '--limit', '500').map((t) => [t.title, t])
  )
  const project = Object.fromEntries(cli('projects', 'list').map((p) => [p.name, p.id]))
  const starts = {
    'Mobile navigation': 0,
    'Draft sitemap': 1,
    'Build style guide page': 2,
    'Case study template': 4,
    'Accessibility pass': 7,
    'Book apartment in Alfama': -3,
    'Buy a travel adapter': 1,
    'Plan the Sintra day trip': 3,
    'Fix the bathroom tap': 3
  }
  for (const [title, offset] of Object.entries(starts))
    cli('tasks', 'update', byTitle[title].id, '--start', day(offset))
  const filed = {
    'Reply to Jonas about the workshop': 'Website Redesign',
    'Renew the portfolio domain': 'Home',
    'Read Refactoring UI, chapter 3': 'Home',
    'Back up the laptop': 'Home'
  }
  for (const [title, name] of Object.entries(filed))
    cli('tasks', 'update', byTitle[title].id, '--project', project[name])
  cli(
    'calendar',
    'events',
    'create',
    'Studio North on-site, Copenhagen',
    '--start',
    day(5),
    '--end',
    day(6),
    '--timezone',
    TIMEZONE,
    '--all-day',
    'true'
  )
}
